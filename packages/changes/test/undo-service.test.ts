import { isAppError } from '@pms/core/errors';
import { ProtonHttp } from '@pms/proton-api';
import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '../src/journal.js';
import { undoChange } from '../src/undo-service.js';

/**
 * The one place this tool is allowed to move mail, and the shape of that permission.
 *
 * Two properties matter more than anything else here, and both are about what undo must *not* do.
 *
 * It must never take a folder and move its contents. Somebody who filed mail into that folder by
 * hand after the change would lose it to a cleanup they never asked for, invisibly. So every
 * request must carry an explicit list of ids that came from the journal — which is what the
 * assertions below count.
 *
 * And it must remove the rule before it moves the mail. The filter is still running; move first and
 * Proton re-files everything within the hour, which reads as undo silently not working.
 */

interface Call {
    method: string;
    path: string;
    body: { IDs?: string[]; LabelID?: string } | undefined;
}

function fakeProton(): { http: ProtonHttp; calls: Call[] } {
    const calls: Call[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: new URL(String(input)).pathname.replace(/^\/api\//, ''),
            body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Call['body']),
        });
        return new Response(JSON.stringify({ Code: 1000 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const http = new ProtonHttp({ version: 'test', fetchImpl, minIntervalMs: 0, jitterMs: 0, maxAttempts: 1 });
    http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });
    return { http, calls };
}

const FOLDER_IDS = new Map([
    ['Neu', 'l-neu'],
    ['Rechnungen', 'l-rechnungen'],
    ['Archiv', 'l-archiv'],
]);

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
    return {
        id: 'j-1',
        at: 1_700_000_000,
        change: { id: 'c-1', kind: 'create-rule', summary: 'Regel anlegen' },
        inverse: { id: 'c-1-undo', kind: 'delete-rule', summary: 'Regel entfernen' },
        moved: [
            { messageId: 'm-1', previousLabelIds: ['l-rechnungen'], movedTo: 'Neu' },
            { messageId: 'm-2', previousLabelIds: ['l-rechnungen'], movedTo: 'Neu' },
            { messageId: 'm-3', previousLabelIds: ['l-archiv'], movedTo: 'Neu' },
        ],
        ...over,
    };
}

/** Everything still where the change put it. */
const allStillThere = async (ids: string[]): Promise<Array<{ ID: string; LabelIDs: string[] }>> =>
    ids.map((id) => ({ ID: id, LabelIDs: ['l-neu'] }));

describe('undoing a change', () => {
    it('removes the rule before it moves any mail', async () => {
        const proton = fakeProton();
        const order: string[] = [];

        await undoChange(entry(), {
            http: proton.http,
            applyInverse: async () => {
                order.push('rule');
            },
            readCurrent: allStillThere,
            folderIds: FOLDER_IDS,
        });

        order.push(...proton.calls.filter((call) => call.method !== 'GET').map(() => 'mail'));
        expect(order[0]).toBe('rule');
    });

    it('moves each message to the folder the journal recorded, grouped', async () => {
        const proton = fakeProton();

        const outcome = await undoChange(entry(), {
            http: proton.http,
            applyInverse: async () => undefined,
            readCurrent: allStillThere,
            folderIds: FOLDER_IDS,
        });

        // Two previous folders, so two requests — not one per message and not one for everything.
        expect(outcome.restored).toEqual([
            { targetLabelId: 'l-rechnungen', messageIds: ['m-1', 'm-2'] },
            { targetLabelId: 'l-archiv', messageIds: ['m-3'] },
        ]);
    });

    it('names every message it moves, and never a folder to sweep', async () => {
        // The assertion that keeps undo from swallowing mail somebody filed by hand: there is no
        // request shape here that means "everything in this folder".
        const proton = fakeProton();

        await undoChange(entry(), {
            http: proton.http,
            applyInverse: async () => undefined,
            readCurrent: allStillThere,
            folderIds: FOLDER_IDS,
        });

        const moves = proton.calls.filter((call) => call.path.includes('batch/move'));
        expect(moves.length).toBeGreaterThan(0);
        for (const move of moves) {
            expect(Array.isArray(move.body?.IDs)).toBe(true);
            expect(move.body?.IDs?.length).toBeGreaterThan(0);
        }

        const touched = moves.flatMap((move) => move.body?.IDs ?? []);
        expect(touched.sort()).toEqual(['m-1', 'm-2', 'm-3']);
    });

    it('leaves a message somebody has since moved by hand exactly where it is', async () => {
        const proton = fakeProton();

        const outcome = await undoChange(entry(), {
            http: proton.http,
            applyInverse: async () => undefined,
            // m-2 is no longer in the folder the change put it in.
            readCurrent: async (ids) =>
                ids.map((id) => ({ ID: id, LabelIDs: id === 'm-2' ? ['l-woanders'] : ['l-neu'] })),
            folderIds: FOLDER_IDS,
        });

        expect(outcome.skippedMovedSince).toEqual(['m-2']);
        const touched = proton.calls.flatMap((call) => call.body?.IDs ?? []);
        expect(touched).not.toContain('m-2');

        // And it says so rather than reporting a clean undo.
        expect(isAppError(outcome.partial) && outcome.partial.code).toBe('UNDO_PARTIAL_RESTORE');
    });

    it('reports a message with no recorded previous folder instead of guessing one', async () => {
        const proton = fakeProton();

        const outcome = await undoChange(
            entry({ moved: [{ messageId: 'm-9', previousLabelIds: [], movedTo: 'Neu' }] }),
            {
                http: proton.http,
                applyInverse: async () => undefined,
                readCurrent: allStillThere,
                folderIds: FOLDER_IDS,
            }
        );

        expect(outcome.unrestorable).toEqual(['m-9']);
        expect(proton.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    });

    it('restores a message that was in the inbox to the inbox', async () => {
        const proton = fakeProton();

        const outcome = await undoChange(
            entry({ moved: [{ messageId: 'm-1', previousLabelIds: ['0'], movedTo: 'Neu' }] }),
            {
                http: proton.http,
                applyInverse: async () => undefined,
                readCurrent: allStillThere,
                folderIds: FOLDER_IDS,
            }
        );

        expect(outcome.restored).toEqual([{ targetLabelId: '0', messageIds: ['m-1'] }]);
    });

    it('refuses to undo the same entry twice', async () => {
        const proton = fakeProton();

        await expect(
            undoChange(entry({ undoneAt: 1_700_000_100 }), {
                http: proton.http,
                applyInverse: async () => undefined,
                readCurrent: allStillThere,
                folderIds: FOLDER_IDS,
            })
        ).rejects.toMatchObject({ code: 'UNDO_ENTRY_ALREADY_UNDONE' });

        expect(proton.calls).toEqual([]);
    });

    it('marks the entry undone only after the work is done', async () => {
        const proton = fakeProton();
        const record = entry();

        expect(record.undoneAt).toBeUndefined();
        await undoChange(record, {
            http: proton.http,
            applyInverse: async () => undefined,
            readCurrent: allStillThere,
            folderIds: FOLDER_IDS,
        });

        expect(record.undoneAt).toBeDefined();
    });

    it('does not mark it undone when the move fails, so it can be retried', async () => {
        const record = entry();
        const failing = new ProtonHttp({
            version: 'test',
            fetchImpl: async () => new Response('nein', { status: 500 }),
            minIntervalMs: 0,
            jitterMs: 0,
            maxAttempts: 1,
        });
        failing.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });

        await expect(
            undoChange(record, {
                http: failing,
                applyInverse: async () => undefined,
                readCurrent: allStillThere,
                folderIds: FOLDER_IDS,
            })
        ).rejects.toThrow();

        // An entry that looks reversed but is not would be unrecoverable through the interface.
        expect(record.undoneAt).toBeUndefined();
    });
});
