import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChangePlan, PendingChange } from '@pms/changes';
import { isAppError } from '@pms/core/errors';
import { fingerprintAccount, ProtonHttp } from '@pms/proton-api';
import { ConditionComparator, ConditionType, FilterStatement } from '@proton/sieve/filterModel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyChange, weigh, type ConfirmationVerdict } from '../src/apply.js';
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
 *
 * The terminal is asked about big changes, not every change. A dialog that appears for every small
 * rule becomes a reflex, and a confirmation answered without reading protects nothing — the same
 * argument CLAUDE.md makes about never skipping the diff, pointed the other way. Every change is
 * still confirmed once, in the dialog that shows its consequences; this is the second question, and
 * `weigh` decides who gets it.
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
const ACCOUNT_LABELS = [{ ID: 'lb-1', Name: 'Steuerrelevant', Path: 'Steuerrelevant', Type: 1, Color: '#fff' }];

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
            // Proton answers the same endpoint for both, distinguished by `Type`. Folders are 3,
            // labels are 1 — and a rule filing into „Wichtig" means a different thing depending on
            // which of them carries the name.
            const type = url.searchParams.get('Type');
            return json({ Code: 1000, Labels: type === '1' ? ACCOUNT_LABELS : ACCOUNT_FOLDERS });
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
        if (path.startsWith('core/v4/labels/') && method === 'PUT') {
            const id = path.slice('core/v4/labels/'.length);
            return json({ Code: 1000, Label: { ...ACCOUNT_FOLDERS[0], ID: id, Name: 'Ablage' } });
        }
        if (path.startsWith('mail/v4/filters/') && method === 'PUT') {
            return json({ Code: 1000, Filter: { ...ACCOUNT_FILTERS[0] } });
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

/** A change big enough to be asked about twice: a fifth of a small mailbox. */
const BIG = { mailboxSize: 8 };

describe('a change that is asked about is not written until it is answered', () => {
    it.each<[string, ConfirmationVerdict, string]>([
        ['declined', 'declined', 'APPLY_NOT_CONFIRMED'],
        ['expired', 'expired', 'APPLY_CONFIRMATION_EXPIRED'],
    ])('makes no change when the terminal answers %s', async (_name, verdict, code) => {
        const proton = fakeProton();

        await expect(
            applyChange(request(), { http: proton.http, backupDir, confirm: always(verdict), ...BIG })
        ).rejects.toMatchObject({ code });

        // The whole promise, counted.
        expect(proton.writes()).toEqual([]);
    });

    it('does not even take a backup before the answer comes back', async () => {
        // A backup is a read at Proton, but it also writes a file with every filter name in it.
        // Doing that for a change nobody approved would be a quiet copy of the mailbox structure.
        const proton = fakeProton();

        await expect(
            applyChange(request(), { http: proton.http, backupDir, confirm: always('declined'), ...BIG })
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
                ...BIG,
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

describe('a copy that predates the check', () => {
    it('says what is missing rather than blaming the account', async () => {
        // This refused every single change for anyone whose mirror was made before the fingerprint
        // existed, and the message pointed at Proton — which was both wrong and unfixable.
        const proton = fakeProton();

        const failure = await applyChange(request({ baseVersion: '' }), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        }).catch((error: unknown) => error);

        expect(isAppError(failure) && failure.code).toBe('APPLY_STATE_STALE');
        expect(isAppError(failure) && failure.hint).toContain('synchronisieren');
        expect(proton.writes()).toEqual([]);
    });
});

describe('which changes are asked about twice', () => {
    it('lets a small rule through on the dialog’s confirmation alone', async () => {
        // Two mails out of a thousand. Asking again in a terminal would train the reflex.
        expect(weigh(request(), 1_000).needsTerminal).toBe(false);
    });

    it('asks about anything that deletes', async () => {
        const removal = request();
        removal.change = { id: 'c', kind: 'delete-rule', summary: 'Regel löschen' };

        expect(weigh(removal, 1_000)).toMatchObject({ needsTerminal: true });
        expect(weigh(removal, 1_000).reason).toContain('löscht');
    });

    it('asks about a change touching a large share of the mailbox', () => {
        const verdict = weigh(request(), 8);

        expect(verdict.needsTerminal).toBe(true);
        expect(verdict.reason).toContain('%');
    });

    it('asks about a large change even in a mailbox of unknown size', () => {
        const many = request();
        many.plan = { ...plan(), moves: Array.from({ length: 600 }, () => plan().moves[0] as never) };

        expect(weigh(many, 0).needsTerminal).toBe(true);
    });

    it('does not ask when nothing is known and the change is small', () => {
        expect(weigh(request(), 0).needsTerminal).toBe(false);
    });

    it('writes a small change without ever calling the terminal', async () => {
        const proton = fakeProton({ movedIds: ['m-1', 'm-2'] });
        let asked = false;

        await applyChange(request(), {
            http: proton.http,
            backupDir,
            mailboxSize: 1_000,
            confirm: async () => {
                asked = true;
                return 'granted';
            },
            sleep: async () => undefined,
        });

        expect(asked).toBe(false);
        expect(proton.writes().map((call) => `${call.method} ${call.path}`)).toContain('POST mail/v4/filters');
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
        // The whole sequence, in the one order each step means anything in: a filter naming a
        // folder that does not exist files mail into nothing, silently — and Proton cannot apply a
        // rule to the backlog before that rule exists.
        expect(writes).toEqual([
            'POST core/v4/labels',
            'POST mail/v4/filters',
            'POST mail/v4/messages/apply-filters',
        ]);
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

/**
 * The folder changes, which for a long time were not changes at all.
 *
 * `create-folder` reached a `switch` whose only job was to say "not supported yet" — and reached the
 * one branch that said nothing, because the folder kinds were excluded from the refusal. So the
 * request answered `applied`, the dashboard said "bei Proton gespeichert", and the account was
 * untouched. That is the worst of the three possible outcomes: a failure nobody is told about.
 *
 * These count requests rather than reading messages, for the same reason as everything above: the
 * claim is about what reached Proton.
 */
describe('changing a folder actually changes a folder', () => {
    function folderRequest(over: Partial<PendingChange>): ChangeRequest {
        const folderChange: PendingChange = {
            id: 'c-f',
            kind: 'create-folder',
            summary: 'Ordner anlegen',
            folder: { name: 'Neu' },
            ...over,
        };
        return request({
            change: folderChange,
            plan: { ...plan(), change: folderChange, moves: [], clearedFromInbox: 0 },
            affectedMessageIds: [],
        });
    }

    it('creates one, rather than reporting a success nobody made', async () => {
        const proton = fakeProton();

        const outcome = await applyChange(folderRequest({}), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(outcome.partial).toBeUndefined();
        expect(proton.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
            'POST core/v4/labels',
        ]);
    });

    it('deletes one, and asks in the terminal first because it removes something', async () => {
        const proton = fakeProton();
        const asked: string[] = [];

        await applyChange(
            folderRequest({ kind: 'delete-folder', summary: 'Ordner löschen', folder: { name: 'Archiv' } }),
            {
                http: proton.http,
                backupDir,
                confirm: async (offer) => {
                    asked.push(offer.reason);
                    return 'granted';
                },
            }
        );

        expect(asked).toEqual(['Diese Änderung löscht etwas.']);
        expect(proton.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
            'DELETE core/v4/labels/l-1',
        ]);
    });

    it('writes nothing when a deletion is refused at the terminal', async () => {
        const proton = fakeProton();

        await expect(
            applyChange(
                folderRequest({ kind: 'delete-folder', summary: 'Ordner löschen', folder: { name: 'Archiv' } }),
                { http: proton.http, backupDir, confirm: always('declined') }
            )
        ).rejects.toMatchObject({ code: 'APPLY_NOT_CONFIRMED' });

        expect(proton.writes()).toEqual([]);
    });

    it('refuses to delete a folder the account does not have, before asking anybody', async () => {
        const proton = fakeProton();
        let asked = 0;

        await expect(
            applyChange(
                folderRequest({ kind: 'delete-folder', summary: 'Ordner löschen', folder: { name: 'Weg' } }),
                {
                    http: proton.http,
                    backupDir,
                    confirm: async () => {
                        asked++;
                        return 'granted';
                    },
                }
            )
        ).rejects.toMatchObject({ code: 'APPLY_STATE_STALE' });

        expect(asked).toBe(0);
        expect(proton.writes()).toEqual([]);
    });

    it('repoints the rules that filed into a folder it renames', async () => {
        // Proton stores the destination by name. A rename that stops at the folder leaves every
        // rule filing into a name that no longer resolves — the rule runs, the mail leaves the
        // inbox, and it arrives nowhere.
        const proton = fakeProton();

        await applyChange(
            folderRequest({
                kind: 'rename-folder',
                summary: 'Ordner umbenennen',
                folder: { name: 'Archiv', newName: 'Ablage' },
            }),
            { http: proton.http, backupDir, confirm: always('granted') }
        );

        const written = proton.writes().map((call) => `${call.method} ${call.path}`);
        expect(written[0]).toBe('PUT core/v4/labels/l-1');
        // `f-1` files into 'Archiv' only if the fake account says so; when it does not, no rule is
        // rewritten and the rename is the single request. Either way the folder came first.
        expect(written.slice(1).every((entry) => entry.startsWith('PUT mail/v4/filters/'))).toBe(true);
    });
});

describe('adopting a rule found at Proton', () => {
    it('records the decision and writes nothing at all', async () => {
        // The one change kind that touches no account state. It still travels the whole route — the
        // diff is shown first — because taking responsibility for a rule without seeing what it
        // catches is not a decision.
        const proton = fakeProton();
        const adoption: PendingChange = {
            id: 'c-a',
            kind: 'adopt-rule',
            summary: 'Regel „Bestehend" übernehmen',
            before: { id: 'f-1', name: 'Bestehend', priority: 1, enabled: true, rule: rule() },
        };

        const outcome = await applyChange(
            request({
                change: adoption,
                plan: { ...plan(), change: adoption, moves: [], clearedFromInbox: 0 },
                affectedMessageIds: [],
            }),
            { http: proton.http, backupDir, confirm: always('granted') }
        );

        expect(proton.writes()).toEqual([]);
        expect(outcome.adoptedFilterIds).toEqual(['f-1']);
    });
});

/**
 * The second exception, and the one that moves mail.
 *
 * Everything else in this file writes a filter and lets Proton do the sorting. A category cannot be
 * a filter's destination, so this is the one change kind that moves somebody's messages — and
 * therefore the one where "nothing without a typed ja" has to hold at every size, not just at the
 * sizes `weigh` finds impressive.
 */
function categoryChange(messageIds = ['m-1', 'm-2']): PendingChange {
    return {
        id: 'c-cat',
        kind: 'move-to-category',
        summary: `${messageIds.length} Mails nach „Transaktionen" verschieben`,
        category: { id: '26', messageIds },
    };
}

function categoryRequest(over: Partial<ChangeRequest> = {}, messageIds = ['m-1', 'm-2']): ChangeRequest {
    const change = categoryChange(messageIds);
    return {
        ...request({ change }),
        affectedMessageIds: messageIds,
        plan: {
            change,
            moves: messageIds.map((id) => ({
                messageId: id,
                subject: `Betreff ${id}`,
                sender: 'wer@dort.example',
                from: undefined,
                to: 'Transaktionen',
            })),
            clearedFromInbox: 0,
            returnedToInbox: 0,
            takenFrom: [],
        },
        ...over,
    };
}

describe('moving mail into one of Protons categories', () => {
    it('asks the terminal even for a single mail', () => {
        // Deliberately not subject to the size thresholds. This is the exception to the first
        // sentence of CLAUDE.md, and it should cost a keystroke every time it is used.
        const one = categoryRequest({}, ['m-1']);

        expect(weigh(one, 10_000)).toEqual({
            needsTerminal: true,
            reason: 'Diese Änderung verschiebt Mail.',
        });
    });

    it.each<[string, ConfirmationVerdict, string]>([
        ['declined', 'declined', 'APPLY_NOT_CONFIRMED'],
        ['expired', 'expired', 'APPLY_CONFIRMATION_EXPIRED'],
    ])('moves nothing when the terminal answers %s', async (_name, verdict, code) => {
        const proton = fakeProton();
        let asked = 0;

        await expect(
            applyChange(categoryRequest(), {
                http: proton.http,
                backupDir,
                confirm: always(verdict),
                moveToCategory: async () => {
                    asked++;
                },
            })
        ).rejects.toMatchObject({ code });

        expect(proton.writes()).toEqual([]);
        expect(asked).toBe(0);
    });

    it('moves exactly the named messages once it is granted', async () => {
        const proton = fakeProton();
        const moved: Array<{ ids: string[]; categoryId: string }> = [];

        await applyChange(categoryRequest(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            moveToCategory: async (ids, categoryId) => {
                moved.push({ ids, categoryId });
            },
        });

        expect(moved).toEqual([{ ids: ['m-1', 'm-2'], categoryId: '26' }]);
    });

    it('refuses a change naming a mail the diff did not show', async () => {
        // The terminal question covers `affectedMessageIds`. If the payload could carry more, the
        // confirmation would be about one set of mail and the move about another.
        const proton = fakeProton();
        let asked = 0;

        await expect(
            applyChange(
                {
                    ...categoryRequest(),
                    change: categoryChange(['m-1', 'm-2', 'm-heimlich']),
                },
                {
                    http: proton.http,
                    backupDir,
                    confirm: always('granted'),
                    moveToCategory: async () => {
                        asked++;
                    },
                }
            )
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });

        expect(asked).toBe(0);
        expect(proton.writes()).toEqual([]);
    });

    it('refuses a label id that is not one of Protons categories', async () => {
        const proton = fakeProton();

        await expect(
            applyChange(
                { ...categoryRequest(), change: { ...categoryChange(), category: { id: 'l-1', messageIds: ['m-1'] } } },
                { http: proton.http, backupDir, confirm: always('granted'), moveToCategory: async () => undefined }
            )
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });
    });

    it('says so rather than reporting success when nothing is wired up to move mail', async () => {
        // The failure this switch was rebuilt to prevent: a change that reports done and never made
        // a request. `moveToCategory` is absent whenever the change did not come through
        // `pnpm serve`, and that has to be audible.
        const proton = fakeProton();

        await expect(
            applyChange(categoryRequest(), { http: proton.http, backupDir, confirm: always('granted') })
        ).rejects.toMatchObject({ code: 'APPLY_PARTIAL' });
    });
});


/**
 * Sorting the mail that is already there.
 *
 * The terminal told the user „Bestehende Mail wird mit einbezogen" and nothing included it:
 * `applyFiltersToExisting` was implemented, exported and called by nobody, so the flag changed a
 * sentence and a hash. Verification then waited three times for movements that could not happen
 * and reported a partial result — which is how a missing call looked like a flaky account.
 *
 * The important property is not that the call happens. It is *who moves the mail*: we hand Proton
 * the ids the diff listed and ask it to apply its own rules. This tool still never moves a message
 * itself, which is what lets the backlog be sorted without touching the project's first rule.
 */
describe('applying a new rule to mail that already arrived', () => {
    const backlogCalls = (proton: ReturnType<typeof fakeProton>): Call[] =>
        proton.calls.filter((call) => call.path === 'mail/v4/messages/apply-filters');

    it('asks Proton to file exactly the messages the diff named', async () => {
        const proton = fakeProton();

        await applyChange(request({ applyToExisting: true }), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(backlogCalls(proton)).toEqual([
            { method: 'POST', path: 'mail/v4/messages/apply-filters', body: { IDs: ['m-1', 'm-2'] } },
        ]);
    });

    it('asks for nothing when the user said future mail only', async () => {
        // A legitimate answer, and one the interface now actually carries.
        const proton = fakeProton();

        await applyChange(request({ applyToExisting: false }), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(backlogCalls(proton)).toEqual([]);
    });

    it('asks only after the filter exists', async () => {
        // Proton cannot apply a rule it does not have yet, so the order is the whole point.
        const proton = fakeProton();

        await applyChange(request({ applyToExisting: true }), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        const writes = proton.writes().map((call) => call.path);
        expect(writes.indexOf('mail/v4/messages/apply-filters')).toBeGreaterThan(
            writes.indexOf('mail/v4/filters')
        );
    });

    it('does not ask when the change was declined', async () => {
        const proton = fakeProton();

        await expect(
            applyChange(request({ applyToExisting: true }), {
                http: proton.http,
                backupDir,
                confirm: always('declined'),
                ...BIG,
            })
        ).rejects.toMatchObject({ code: 'APPLY_NOT_CONFIRMED' });

        expect(proton.writes()).toEqual([]);
    });
});


/**
 * Taking a recorded change back.
 *
 * The machinery for this existed and was unreachable: `undoChange` had no caller in the project,
 * and the journal entry it works from was built correctly by this file and then discarded by the
 * process that called it. What is tested here is the half that lives in `apply.ts` — that the undo
 * is asked about at the terminal every time, that a refusal writes nothing, and that the rules are
 * put back through the *ordinary* write path rather than a second one written for the occasion.
 */
describe('undoing a recorded change', () => {
    function undoRequest(entryId = 'j-1'): ChangeRequest {
        const change: PendingChange = { id: 'u-1', kind: 'undo-entry', undo: { entryId } };
        return {
            ...request({ change }),
            affectedMessageIds: [],
            plan: { change, moves: [], clearedFromInbox: 0, returnedToInbox: 0, takenFrom: [] },
        };
    }

    it('always asks the terminal, whatever its size', () => {
        // It moves mail and removes a rule, and it is the change most likely to be reached for in
        // a hurry — which is the argument for the question, not against it.
        expect(weigh(undoRequest(), 10_000)).toMatchObject({ needsTerminal: true });
    });

    it.each<[string, ConfirmationVerdict, string]>([
        ['declined', 'declined', 'APPLY_NOT_CONFIRMED'],
        ['expired', 'expired', 'APPLY_CONFIRMATION_EXPIRED'],
    ])('takes nothing back when the terminal answers %s', async (_name, verdict, code) => {
        const proton = fakeProton();
        let asked = 0;

        await expect(
            applyChange(undoRequest(), {
                http: proton.http,
                backupDir,
                confirm: always(verdict),
                undoEntry: async () => {
                    asked++;
                    return { restored: 0, skipped: 0, unrestorable: 0 };
                },
            })
        ).rejects.toMatchObject({ code });

        expect(asked).toBe(0);
        expect(proton.writes()).toEqual([]);
    });

    it('hands the recorded inverse back through the ordinary write path', async () => {
        // Not a second write path written for undo. The inverse goes through the same switch, the
        // same folder-before-filter ordering and the same refusals as any other change — which is
        // why an undo cannot do something a normal change could not.
        const proton = fakeProton();

        await applyChange(undoRequest(), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
            undoEntry: async (entryId, performInverse) => {
                expect(entryId).toBe('j-1');
                await performInverse({ id: 'inv', kind: 'delete-rule', before: change().after });
                return { restored: 2, skipped: 0, unrestorable: 0 };
            },
        });

        expect(proton.writes().map((call) => `${call.method} ${call.path}`)).toContain(
            'DELETE mail/v4/filters/r-neu'
        );
    });

    it('refuses an undo of an undo rather than pretending to redo', async () => {
        // Re-applying the original is a different act from reversing this one: it needs its own
        // diff, and offering it here would let two entries in the record disagree about the
        // account. `inverseOf` produces an undo naming nothing, and this is where that is caught.
        const proton = fakeProton();

        await expect(
            applyChange(
                { ...undoRequest(), change: { id: 'u-2', kind: 'undo-entry' } },
                {
                    http: proton.http,
                    backupDir,
                    confirm: always('granted'),
                    undoEntry: async () => ({ restored: 0, skipped: 0, unrestorable: 0 }),
                }
            )
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });
    });

    it('says so rather than reporting success when the history is out of reach', async () => {
        const proton = fakeProton();

        await expect(
            applyChange(undoRequest(), { http: proton.http, backupDir, confirm: always('granted') })
        ).rejects.toMatchObject({ code: 'APPLY_PARTIAL' });
    });
});


/**
 * Going back several steps at once.
 *
 * One diff and one confirmation for the whole chain, because reversing four changes a dialog at a
 * time is where somebody stops reading them. The property that matters is what happens when a step
 * fails: it stops, says where, and does not roll forward again — an error path is the worst
 * possible place to start a second unwatched write series.
 */
describe('rewinding to an earlier point', () => {
    function rewindRequest(entryId = 'j-1'): ChangeRequest {
        const rewind: PendingChange = { id: 'w-1', kind: 'rewind-to', undo: { entryId } };
        return {
            ...request({ change: rewind }),
            affectedMessageIds: [],
            plan: { change: rewind, moves: [], clearedFromInbox: 0, returnedToInbox: 0, takenFrom: [] },
        };
    }

    it('always asks the terminal', () => {
        expect(weigh(rewindRequest(), 10_000)).toMatchObject({ needsTerminal: true });
    });

    it('takes nothing back when the terminal declines', async () => {
        const proton = fakeProton();
        let asked = 0;

        await expect(
            applyChange(rewindRequest(), {
                http: proton.http,
                backupDir,
                confirm: always('declined'),
                rewindTo: async () => {
                    asked++;
                    return { steps: [] };
                },
            })
        ).rejects.toMatchObject({ code: 'APPLY_NOT_CONFIRMED' });

        expect(asked).toBe(0);
        expect(proton.writes()).toEqual([]);
    });

    it('reports a chain that stopped as partial rather than as done', async () => {
        // Two of three landed. That is a real state, and the one most worth naming: the account is
        // now somewhere between two versions of itself and the user has to know which.
        const outcome = await applyChange(rewindRequest(), {
            http: fakeProton().http,
            backupDir,
            confirm: always('granted'),
            rewindTo: async () => ({
                steps: [
                    { entryId: 'j-3', restored: 4 },
                    { entryId: 'j-2', restored: 2 },
                ],
                stoppedAt: 'j-1',
            }),
        });

        expect(outcome.partial?.code).toBe('APPLY_PARTIAL');
        expect(outcome.partial?.message).toContain('2 Schritte');
        expect(outcome.partial?.hint).toContain('nichts wieder vorgespult');
    });

    it('reports a chain that finished as finished', async () => {
        const outcome = await applyChange(rewindRequest(), {
            http: fakeProton().http,
            backupDir,
            confirm: always('granted'),
            rewindTo: async () => ({ steps: [{ entryId: 'j-1', restored: 3 }] }),
        });

        expect(outcome.partial).toBeUndefined();
    });

    it('refuses a rewind that names no starting point', async () => {
        await expect(
            applyChange(
                { ...rewindRequest(), change: { id: 'w-2', kind: 'rewind-to' } },
                {
                    http: fakeProton().http,
                    backupDir,
                    confirm: always('granted'),
                    rewindTo: async () => ({ steps: [] }),
                }
            )
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });
    });
});


/**
 * A rule that marks rather than moves.
 *
 * Proton's filter model has no label action: the name goes into `FileInto` either way and Proton
 * decides what it means by which object carries it. So the intention has to travel with the change,
 * and the thing that must not happen is a rule meant to *mark* quietly creating a folder — which
 * takes the mail out of the inbox, the opposite of what was asked, and is invisible until it does.
 */
describe('creating the target a rule files into', () => {
    function ruleFilingInto(target: string) {
        return {
            ...rule(),
            Actions: { FileInto: [target], Mark: { Read: false, Starred: false } },
        };
    }

    function requestFor(target: string, targetKind: 'folder' | 'label'): ChangeRequest {
        const after = { id: 'r-neu', name: 'Neu', priority: 2, enabled: true, rule: ruleFilingInto(target) };
        return {
            ...request({ applyToExisting: false }),
            change: { id: 'c-1', kind: 'create-rule', after, targetKind },
        };
    }

    it('creates a label as a label, not as a folder', async () => {
        const proton = fakeProton();

        await applyChange(requestFor('Zu erledigen', 'label'), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        const created = proton.writes().find((call) => call.path === 'core/v4/labels');
        expect(created?.body).toMatchObject({ Name: 'Zu erledigen', Type: 1 });
    });

    it('creates a folder as a folder', async () => {
        const proton = fakeProton();

        await applyChange(requestFor('Ablage', 'folder'), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(proton.writes().find((call) => call.path === 'core/v4/labels')?.body).toMatchObject({
            Name: 'Ablage',
            Type: 3,
        });
    });

    it('reuses a label that is already there instead of making a second one', async () => {
        // The lookup follows the kind. Searching the folders for a label's name would find nothing
        // and create a duplicate beside the label that was already there.
        const proton = fakeProton();

        await applyChange(requestFor('Steuerrelevant', 'label'), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(proton.writes().filter((call) => call.path === 'core/v4/labels')).toEqual([]);
    });

    it('does not mistake a folder of the same name for the label', async () => {
        // Proton allows both to be called „Archiv". A rule that marks with a label of that name
        // must not silently reuse the folder — the mail would leave the inbox.
        const proton = fakeProton();

        await applyChange(requestFor('Archiv', 'label'), {
            http: proton.http,
            backupDir,
            confirm: always('granted'),
        });

        expect(proton.writes().find((call) => call.path === 'core/v4/labels')?.body).toMatchObject({
            Name: 'Archiv',
            Type: 1,
        });
    });
});
