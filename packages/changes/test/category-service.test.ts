import { ProtonHttp } from '@pms/proton-api';
import { describe, expect, it } from 'vitest';

import { moveIntoCategory } from '../src/category-service.js';

/**
 * The second exception to "this tool never moves mail", held to the same shape as the first.
 *
 * What is being protected is not correctness of a count. It is the boundary: this service may move
 * only messages it was handed, it may not go looking for more, and what it reports has to be what
 * happened rather than what was asked for. A service that quietly counted a missing message as
 * moved would make undo move it back from somewhere it never was.
 */

interface Call {
    method: string;
    path: string;
    body: unknown;
}

function fakeProton(): { http: ProtonHttp; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({
            method: init?.method ?? 'GET',
            path: url.pathname.replace(/^\/api\//, ''),
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
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

const current = (states: Record<string, string[]>) => async (ids: string[]) =>
    ids.filter((id) => id in states).map((id) => ({ ID: id, LabelIDs: states[id] ?? [] }));

describe('moving named messages into a category', () => {
    it('sends the message-shaped call, not the conversation one', async () => {
        // Labelling a conversation moves the whole thread, which is more than anybody selected.
        // Proton's own client sends the conversation variant because its mailbox shows threads;
        // that is a reason to know about it, not a reason to copy it.
        const proton = fakeProton();

        await moveIntoCategory(['m-1', 'm-2'], '26', {
            http: proton.http,
            readCurrent: current({ 'm-1': ['0'], 'm-2': ['0', '24'] }),
        });

        expect(proton.calls).toEqual([
            { method: 'PUT', path: 'mail/v4/messages/label', body: { LabelID: '26', IDs: ['m-1', 'm-2'] } },
        ]);
    });

    it('records where each message was, one at a time', async () => {
        // The record undo works from. Per message, observed, never derived from the plan — a
        // message that was in „Standard" and one that was only in the inbox go back to different
        // places, and a single shared „vorher" would send one of them to the wrong one.
        const outcome = await moveIntoCategory(['m-1', 'm-2'], '26', {
            http: fakeProton().http,
            readCurrent: current({ 'm-1': ['0'], 'm-2': ['0', '24'] }),
        });

        expect(outcome.moved).toEqual([
            { messageId: 'm-1', previousLabelIds: ['0'] },
            { messageId: 'm-2', previousLabelIds: ['0', '24'] },
        ]);
    });

    it('leaves a message that is already there alone', async () => {
        const proton = fakeProton();

        const outcome = await moveIntoCategory(['m-1', 'm-2'], '26', {
            http: proton.http,
            readCurrent: current({ 'm-1': ['0', '26'], 'm-2': ['0'] }),
        });

        expect(outcome.alreadyThere).toEqual(['m-1']);
        expect(proton.calls[0]?.body).toEqual({ LabelID: '26', IDs: ['m-2'] });
    });

    it('asks Proton for nothing when there is nothing left to move', async () => {
        const proton = fakeProton();

        await moveIntoCategory(['m-1'], '26', {
            http: proton.http,
            readCurrent: current({ 'm-1': ['0', '26'] }),
        });

        expect(proton.calls).toEqual([]);
    });

    it('names a message it could not find rather than counting it as moved', async () => {
        // The ordinary case: the mailbox moved on between the sync and the confirmation. Rounding
        // it up would put a message in the journal that never went anywhere, and undo would then
        // move it back from a place it had never been.
        const outcome = await moveIntoCategory(['m-1', 'm-weg'], '26', {
            http: fakeProton().http,
            readCurrent: current({ 'm-1': ['0'] }),
        });

        expect(outcome.missing).toEqual(['m-weg']);
        expect(outcome.moved.map((entry) => entry.messageId)).toEqual(['m-1']);
        expect(outcome.partial?.code).toBe('APPLY_PARTIAL');
    });

    it('refuses a label that is not one of Protons categories', async () => {
        const proton = fakeProton();

        await expect(
            moveIntoCategory(['m-1'], 'MTIzNDU2Nzg5MDEyMzQ1Ng', {
                http: proton.http,
                readCurrent: current({ 'm-1': ['0'] }),
            })
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });

        expect(proton.calls).toEqual([]);
    });

    it('refuses to move nothing, rather than treating it as a no-op', async () => {
        // An empty list is not "move zero messages"; it is a caller that lost its ids somewhere.
        // The one thing this function must never learn to do is fill a gap in its input.
        await expect(
            moveIntoCategory([], '26', { http: fakeProton().http, readCurrent: current({}) })
        ).rejects.toMatchObject({ code: 'APPLY_MALFORMED' });
    });
});
