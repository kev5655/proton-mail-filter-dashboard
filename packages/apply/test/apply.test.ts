import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChangePlan, PendingChange } from '@pms/changes';
import { isAppError } from '@pms/core/errors';
import { fingerprintAccount, ProtonHttp } from '@pms/proton-api';
import { ConditionComparator, ConditionType, FilterStatement } from '@proton/sieve/filterModel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyChange, type ConfirmationVerdict } from '../src/apply.js';
import { digestOf, shortDigest, type ChangeRequest } from '../src/request.js';

/**
 * The central claim of this project, stated as a test.
 *
 * "Nothing reaches Proton without an explicit confirmation" is a sentence anyone can write. What
 * makes it true is that a declined, expired or stale request produces *zero* non-GET calls — and
 * the way to know that is to count them.
 *
 * So every test below drives a recording `fetch`. The assertion is almost always the same one: how
 * many requests changed anything, and in what order. The order matters as much as the count: a
 * filter written before its folder exists is a rule that files mail into nothing, silently.
 */

const ACCOUNT_FILTERS = [
    {
        ID: 'f-1',
        Name: 'Bestehend',
        Status: 1,
        Priority: 1,
        Version: 2 as const,
        Sieve: 'keep;',
        Tree: [],
    },
];

const ACCOUNT_FOLDERS = [{ ID: 'l-1', Name: 'Archiv', Path: 'Archiv', Type: 3, Color: '#fff' }];

interface Call {
    method: string;
    path: string;
    body: unknown;
}

/** A Proton that answers plausibly and remembers everything it was asked. */
function fakeProton(over: { failFilterWrite?: boolean; movedIds?: string[] } = {}): {
    http: ProtonHttp;
    calls: Call[];
    writes: () => Call[];
} {
    const calls: Call[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const path = url.pathname.replace(/^\/api\//, '');
        calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });

        const json = (value: unknown): Response =>
            new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

        if (path === 'mail/v4/filters' && method === 'GET') {
            return json({ Code: 1000, Filters: ACCOUNT_FILTERS });
        }
        if (path.startsWith('core/v4/labels') && method === 'GET') {
            return json({ Code: 1000, Labels: ACCOUNT_FOLDERS });
        }
        if (path === 'mail/v4/messages' && method === 'GET') {
            const moved = new Set(over.movedIds ?? []);
            return json({
                Code: 1000,
                Total: 2,
                Messages: ['m-1', 'm-2'].map((id) => ({
                    ID: id,
                    Subject: `Betreff ${id}`,
                    Sender: { Address: 'wer@dort.example', Name: 'Wer' },
                    ToList: [],
                    Time: 1_700_000_000,
                    LabelIDs: moved.has(id) ? ['l-neu'] : ['0'],
                    Unread: 0,
                    NumAttachments: 0,
                })),
            });
        }
        if (path === 'core/v4/labels' && method === 'POST') {
            return json({ Code: 1000, Label: { ID: 'l-neu', Name: 'Neu', Path: 'Neu', Type: 3, Color: '#fff' } });
        }
        if (path === 'mail/v4/filters' && method === 'POST') {
            if (over.failFilterWrite === true) {
                return new Response(JSON.stringify({ Code: 2000, Error: 'nein' }), { status: 422 });
            }
            return json({ Code: 1000, Filter: { ...ACCOUNT_FILTERS[0], ID: 'f-neu', Name: 'Neu' } });
        }
        return json({ Code: 1000 });
    };

    const http = new ProtonHttp({ version: 'test', fetchImpl, minIntervalMs: 0, jitterMs: 0, maxAttempts: 1 });
    http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });

    return {
        http,
        calls,
        writes: () => calls.filter((call) => call.method !== 'GET'),
    };
}

function rule() {
    return {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: 'sender', value: ConditionType.SENDER },
                Comparator: { label: 'contains', value: ConditionComparator.CONTAINS },
                Values: ['dort.example'],
            },
        ],
        Actions: { FileInto: ['Neu'], Mark: { Read: false, Starred: false } },
    };
}

function change(): PendingChange {
    return {
        id: 'c-1',
        kind: 'create-rule',
        summary: 'Regel „Neu" anlegen',
        after: { id: 'r-neu', name: 'Neu', priority: 2, enabled: true, rule: rule() },
    };
}

function plan(): ChangePlan {
    return {
        change: change(),
        moves: [
            { messageId: 'm-1', subject: 'Betreff m-1', sender: 'wer@dort.example', from: undefined, to: 'Neu' },
            { messageId: 'm-2', subject: 'Betreff m-2', sender: 'wer@dort.example', from: undefined, to: 'Neu' },
        ],
        clearedFromInbox: 2,
        returnedToInbox: 0,
        takenFrom: [],
    };
}

function request(over: Partial<ChangeRequest> = {}): ChangeRequest {
    return {
        requestId: 'req-1',
        createdAt: 1_700_000_000,
        change: change(),
        plan: plan(),
        affectedMessageIds: ['m-1', 'm-2'],
        applyToExisting: true,
        baseVersion: fingerprintAccount(ACCOUNT_FILTERS as never, ACCOUNT_FOLDERS as never),
        ...over,
    };
}

let backupDir: string;

beforeEach(async () => {
    backupDir = await mkdtemp(join(tmpdir(), 'pms-apply-'));
});

afterEach(async () => {
    await rm(backupDir, { recursive: true, force: true });
});

const always =
    (verdict: ConfirmationVerdict) =>
    async (): Promise<ConfirmationVerdict> =>
        verdict;

describe('nothing is written without a confirmation', () => {
    it.each<[string, ConfirmationVerdict, string]>([
        ['declined', 'declined', 'APPLY_NOT_CONFIRMED'],
        ['expired', 'expired', 'APPLY_CONFIRMATION_EXPIRED'],
    ])('makes no change when the terminal answers %s', async (_name, verdict, code) => {
        const proton = fakeProton();

        await expect(
            applyChange(request(), { http: proton.http, backupDir, confirm: always(verdict) })
        ).rejects.toMatchObject({ code });

        // The whole promise, counted.
        expect(proton.writes()).toEqual([]);
    });

    it('does not even take a backup before the answer comes back', async () => {
        // A backup is a read at Proton, but it also writes a file with every filter name in it.
        // Doing that for a change nobody approved would be a quiet copy of the mailbox structure.
        const proton = fakeProton();

        await expect(
            applyChange(request(), { http: proton.http, backupDir, confirm: always('declined') })
        ).rejects.toThrow();

        const order = proton.calls.map((call) => call.path);
        expect(order.filter((path) => path === 'mail/v4/filters')).toHaveLength(1);
    });

    it('refuses a plan computed against a mailbox that has since changed', async () => {
        const proton = fakeProton();
        let asked = false;

        await expect(
            applyChange(request({ baseVersion: 'etwas-anderes' }), {
                http: proton.http,
                backupDir,
                confirm: async () => {
                    asked = true;
                    return 'granted';
                },
            })
        ).rejects.toMatchObject({ code: 'APPLY_STATE_STALE' });

        expect(proton.writes()).toEqual([]);
        // And nobody was asked to approve a diff that no longer describes anything.
        expect(asked).toBe(false);
    });
});

describe('when it is confirmed', () => {
    it('creates the folder before the filter', async () => {
        const proton = fakeProton({ movedIds: ['m-1', 'm-2'] });

        await applyChange(request(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            sleep: async () => undefined,
        });

        const writes = proton.writes().map((call) => `${call.method} ${call.path}`);
        // A filter naming a folder that does not exist files mail into nothing, silently.
        expect(writes).toEqual(['POST core/v4/labels', 'POST mail/v4/filters']);
    });

    it('takes a backup, and it lands on disk', async () => {
        const proton = fakeProton({ movedIds: ['m-1', 'm-2'] });

        const outcome = await applyChange(request(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            sleep: async () => undefined,
        });

        expect(outcome.backupPath).toContain(backupDir);
    });

    it('journals what was observed, not what was planned', async () => {
        // Only one of the two messages actually moved. Undo works from this record, so a journal
        // built from the plan would try to move back mail that never went anywhere.
        const proton = fakeProton({ movedIds: ['m-1'] });

        const outcome = await applyChange(request(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            sleep: async () => undefined,
        });

        expect(outcome.entry.moved.map((moved) => moved.messageId)).toEqual(['m-1']);
        expect(outcome.entry.verification?.confirmed).toBe(1);
    });

    it('raises a partial result rather than rounding it up', async () => {
        const proton = fakeProton({ movedIds: ['m-1'] });

        const outcome = await applyChange(request(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            sleep: async () => undefined,
        });

        expect(outcome.partial).toBeDefined();
        expect(isAppError(outcome.partial) && outcome.partial.code).toBe('VERIFY_PARTIAL_MOVE');
        expect(outcome.partial?.message).toContain('1 von 2');
    });

    it('does not delete a folder it just created when the filter fails', async () => {
        // Deleting a folder moves the mail inside it, and an error path is the worst possible place
        // to do that unwatched.
        const proton = fakeProton({ failFilterWrite: true });

        const outcome = await applyChange(request(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            sleep: async () => undefined,
        });

        expect(proton.writes().some((call) => call.method === 'DELETE')).toBe(false);
        expect(isAppError(outcome.partial) && outcome.partial.code).toBe('APPLY_PARTIAL');
    });
});

describe('the digest', () => {
    it('is the same for two requests describing the same change', () => {
        expect(digestOf(request({ requestId: 'a', createdAt: 1 }))).toBe(
            digestOf(request({ requestId: 'b', createdAt: 2 }))
        );
    });

    it('differs when the effect differs', () => {
        const other = request();
        other.plan = { ...plan(), moves: [plan().moves[0] as never] };

        expect(digestOf(other)).not.toBe(digestOf(request()));
    });

    it('is short enough for a person to compare', () => {
        expect(shortDigest(digestOf(request()))).toMatch(/^[0-9A-F]{3}-[0-9A-F]{3}$/);
    });
});
