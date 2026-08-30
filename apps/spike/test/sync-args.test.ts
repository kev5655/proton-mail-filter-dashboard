import { describe, expect, it } from 'vitest';

import { parseSyncArgs } from '../src/sync-command.js';

/**
 * How much of someone's mailbox a command line asks for.
 *
 * Both values are promises to the account owner: how far back this reaches, and how much it pulls.
 * A typo must not turn either into "everything" — an unrecognised window falls back to the smallest
 * one, not the largest, and a nonsensical limit falls back to the default rather than to none.
 */
describe('reading the sync arguments', () => {
    it('defaults to the smallest window and a modest limit', () => {
        expect(parseSyncArgs(['node', 'main.ts', '--sync'])).toEqual({ window: '30', maxMessages: 2_000 });
    });

    it('takes the window and the limit when given', () => {
        expect(parseSyncArgs(['--sync', '--days', '365', '--max', '500'])).toEqual({
            window: '365',
            maxMessages: 500,
        });
    });

    it('allows asking for everything, but only by saying so', () => {
        expect(parseSyncArgs(['--sync', '--days', 'all']).window).toBe('all');
    });

    it('falls back to the smallest window on a typo, never the largest', () => {
        // "--days alles" must not be read as "all".
        expect(parseSyncArgs(['--sync', '--days', 'alles']).window).toBe('30');
        expect(parseSyncArgs(['--sync', '--days']).window).toBe('30');
    });

    it('refuses a limit that is not a positive number', () => {
        expect(parseSyncArgs(['--sync', '--max', 'viele']).maxMessages).toBe(2_000);
        expect(parseSyncArgs(['--sync', '--max', '-5']).maxMessages).toBe(2_000);
        expect(parseSyncArgs(['--sync', '--max', '0']).maxMessages).toBe(2_000);
    });
});
