import { describe, expect, it } from 'vitest';

import { DEFAULT_MIN_INTERVAL_MS, ProtonHttp } from '../src/http.js';
import { z } from 'zod';

/**
 * How hard the tool leans on Proton's API.
 *
 * Proton runs this service for its users and gets nothing from us for it. The tool answers
 * questions nobody is waiting on by the second — which rules are dead, which mail groups together —
 * so there is no reason for it to cost more than a person clicking through their own mailbox.
 *
 * That is a promise about behaviour, and a promise about behaviour is worth what its test is worth.
 * Most of these run on a fake clock, so the suite stays fast. The one that asks whether concurrent
 * requests really queue uses real timers at a twentieth of the interval, because a clock that jumps
 * on demand cannot tell five waits in a row from five waits at once.
 */

const schema = z.object({ Code: z.number() });

/** A clock that only moves when something waits on it. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; waits: number[] } {
    let time = 0;
    const waits: number[] = [];
    return {
        now: () => time,
        sleep: async (ms: number) => {
            waits.push(ms);
            time += ms;
        },
        waits,
    };
}

function client(overrides: Partial<ConstructorParameters<typeof ProtonHttp>[0]> = {}): {
    http: ProtonHttp;
    startedAt: number[];
    clock: ReturnType<typeof fakeClock>;
} {
    const clock = fakeClock();
    const startedAt: number[] = [];

    const http = new ProtonHttp({
        version: '0.0.0',
        jitterMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        random: () => 0,
        fetchImpl: (async () => {
            startedAt.push(clock.now());
            return new Response(JSON.stringify({ Code: 1000 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as typeof fetch,
        ...overrides,
    });
    // A client with no session refuses anything that is not the login handshake, so a test
    // about pacing has to have one.
    http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });

    return { http, startedAt, clock };
}

const get = { method: 'GET', path: 'core/v4/labels' } as const;

describe('going easy on Protons API', () => {
    it('leaves a gap between requests without being asked to', async () => {
        const { http, startedAt } = client();

        await http.request(get, schema);
        await http.request(get, schema);
        await http.request(get, schema);

        expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(DEFAULT_MIN_INTERVAL_MS);
        expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(DEFAULT_MIN_INTERVAL_MS);
    });

    it('turns a burst into a sequence instead of a burst after one delay', async () => {
        // The failure mode worth pinning: five concurrent calls each waiting the same interval and
        // then all firing together is a worse burst than no pacing at all, and it looks accidental.
        //
        // Real timers here, at a twentieth of the real interval. A fake clock that jumps on demand
        // cannot tell "five waits in a row" from "five waits at once", which is the whole question.
        const startedAt: number[] = [];
        const interval = 20;
        const http = new ProtonHttp({
            version: '0.0.0',
            minIntervalMs: interval,
            jitterMs: 0,
            fetchImpl: (async () => {
                startedAt.push(Date.now());
                return new Response(JSON.stringify({ Code: 1000 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as typeof fetch,
        });
        // A client with no session refuses anything that is not the login handshake, so a test
        // about pacing has to have one.
        http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });

        const began = Date.now();
        await Promise.all(Array.from({ length: 5 }, async () => http.request(get, schema)));

        expect(startedAt).toHaveLength(5);
        // Five paced requests cannot fit into less than four intervals, however they are started.
        expect(Date.now() - began).toBeGreaterThanOrEqual(interval * 4);
    });

    it('adds jitter so the traffic has no shape', async () => {
        // A request exactly every 900 ms is itself a machine signature.
        const randoms = [0.1, 0.9, 0.5];
        let index = 0;
        const { http, startedAt } = client({ jitterMs: 1000, random: () => randoms[index++ % randoms.length]! });

        await http.request(get, schema);
        await http.request(get, schema);
        await http.request(get, schema);

        const gaps = startedAt.slice(1).map((time, i) => time - startedAt[i]!);
        expect(new Set(gaps).size).toBeGreaterThan(1);
    });

    it('paces retries too, since a failing endpoint is the worst one to hammer', async () => {
        let calls = 0;
        const clock = fakeClock();
        const http = new ProtonHttp({
            version: '0.0.0',
            jitterMs: 0,
            maxAttempts: 3,
            now: clock.now,
            sleep: clock.sleep,
            random: () => 0,
            fetchImpl: (async () => {
                calls += 1;
                return new Response('{}', { status: 500 });
            }) as typeof fetch,
        });
        // A client with no session refuses anything that is not the login handshake, so a test
        // about pacing has to have one.
        http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });

        await http.request(get, schema).catch(() => undefined);

        expect(calls).toBe(3);
        // Two pacing gaps beyond the first request, plus the backoff waits.
        expect(clock.waits.filter((wait) => wait >= DEFAULT_MIN_INTERVAL_MS).length).toBeGreaterThanOrEqual(2);
    });

    it('can be switched off, which only tests may do', async () => {
        const { http, startedAt } = client({ minIntervalMs: 0, jitterMs: 0 });

        await http.request(get, schema);
        await http.request(get, schema);

        expect(startedAt[1]! - startedAt[0]!).toBe(0);
    });
});
