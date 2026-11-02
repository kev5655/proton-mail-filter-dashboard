import { describe, expect, it } from 'vitest';

import { ProtonHttp } from '../src/http.js';
import { moveMessagesToCategory } from '../src/write/messages.js';

/**
 * The request itself, at the point where it stops being ours.
 *
 * Everything above this function argues about whether a move should happen. This is the last place
 * anything can be checked, so what it refuses matters more than what it sends: a label id that is
 * not a category cannot be corrected further down, it just moves somebody's mail somewhere.
 */

interface Call {
    method: string;
    path: string;
    body: { LabelID?: string; IDs?: string[] } | undefined;
}

function fakeProton(): { http: ProtonHttp; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({
            method: init?.method ?? 'GET',
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

describe('labelling messages with a category', () => {
    it('sends what Protons own client sends, in message form', () => {
        // Recorded from Proton moving a mail into „Transaktionen" and matched against
        // `labelMessages` in WebClients. The conversation variant of the same call is what the
        // capture showed and is deliberately not what we send: it moves the whole thread.
        const proton = fakeProton();

        return moveMessagesToCategory(proton.http, ['m-1'], '26').then(() => {
            expect(proton.calls).toEqual([
                { method: 'PUT', path: 'mail/v4/messages/label', body: { LabelID: '26', IDs: ['m-1'] } },
            ]);
        });
    });

    it('refuses anything that is not one of Protons categories', async () => {
        // By construction this function can label a message with a category and nothing else. A
        // folder id here would file mail into a folder with no rule, no diff and no journal entry
        // explaining it.
        const proton = fakeProton();

        await expect(moveMessagesToCategory(proton.http, ['m-1'], 'l-archiv')).rejects.toMatchObject({
            code: 'APPLY_MALFORMED',
        });
        await expect(moveMessagesToCategory(proton.http, ['m-1'], '23')).rejects.toMatchObject({
            code: 'APPLY_MALFORMED',
        });

        expect(proton.calls).toEqual([]);
    });

    it('splits a large set so a failure is visible per batch', async () => {
        const proton = fakeProton();
        const ids = Array.from({ length: 250 }, (_, index) => `m-${String(index)}`);

        await moveMessagesToCategory(proton.http, ids, '21');

        expect(proton.calls.map((call) => call.body?.IDs?.length)).toEqual([100, 100, 50]);
    });
});
