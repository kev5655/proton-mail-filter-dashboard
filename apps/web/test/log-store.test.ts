import { beforeEach, describe, expect, it } from 'vitest';

import { buildIncidentReport, log, snapshot, subscribe } from '../src/log.js';

/**
 * The store behind „Protokoll", and the crash it caused.
 *
 * `snapshot()` used to return `[...entries].reverse()` — a new array on every call. React's
 * `useSyncExternalStore` compares consecutive snapshots with `Object.is` and re-renders until two
 * agree, so it never settled: it looped, warned, and threw. A thrown render unmounts the root, so
 * the whole application disappeared and only the sidebar's absence made it obvious.
 *
 * The identity assertion below is the entire fix expressed as a test. It is cheap and it is exactly
 * the property React relies on, which is why it is worth pinning rather than trusting the comment
 * in `log.ts`.
 */

// The store is a module singleton; drain it so each test starts from a known length.
beforeEach(() => {
    while (snapshot().length > 0) {
        // Nothing exported clears it, and adding a clear just for tests would be a production
        // affordance nobody asked for. 500 is the cap, so filling past it drops the old entries.
        for (let index = 0; index < 501; index++) {
            log('info', 'test.drain');
        }
        break;
    }
});

describe('the snapshot', () => {
    it('keeps the same identity between calls', () => {
        expect(snapshot()).toBe(snapshot());
    });

    it('changes identity exactly when something is logged', () => {
        const before = snapshot();
        log('info', 'test.event');
        const after = snapshot();

        expect(after).not.toBe(before);
        expect(snapshot()).toBe(after);
    });

    it('is newest first', () => {
        log('info', 'test.first');
        log('info', 'test.second');

        expect(snapshot()[0]?.event).toBe('test.second');
    });
});

describe('subscribers', () => {
    it('are notified, and unsubscribing returns nothing', () => {
        let calls = 0;
        const unsubscribe = subscribe(() => {
            calls++;
        });

        log('info', 'test.notify');
        expect(calls).toBe(1);

        // React expects a void cleanup; returning Set.delete's boolean is a quiet type mismatch.
        expect(unsubscribe()).toBeUndefined();

        log('info', 'test.after-unsubscribe');
        expect(calls).toBe(1);
    });
});

describe('the incident report', () => {
    it('carries events and codes but no mail content', () => {
        log('error', 'rule.stage.failed', { code: 'RULE_COMPILE_FAILED', count: 3 });

        const report = buildIncidentReport('0.1.0');

        expect(report).toContain('rule.stage.failed');
        expect(report).toContain('RULE_COMPILE_FAILED');
        // The report exists to be pasted into a chat window unedited. Nothing that could carry a
        // subject line or an address may reach it — see the contract in log.ts.
        expect(report).not.toMatch(/[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    });
});
