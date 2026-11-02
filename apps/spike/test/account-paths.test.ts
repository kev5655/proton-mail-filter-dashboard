import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { accountDir, DATA_DIR, useAccountDir } from '../src/paths.js';

/**
 * Which account's files this process is looking at.
 *
 * The reason this is a module-level value rather than an argument threaded through everything is
 * that it describes the process: it holds exactly one account's key at a time, and this says whose.
 * The reason it is *tested* is that the failure it prevents is silent and serious — the session
 * file and the login-attempt record used to be module constants, so a second account would have
 * reached Proton with the first account's tokens and shared its lockout.
 */

afterEach(() => {
    useAccountDir(DATA_DIR);
});

describe('the account a process is holding', () => {
    it('starts at the data directory, where an installation without an index keeps its files', () => {
        expect(accountDir()).toBe(DATA_DIR);
    });

    it('moves, and everything derived from it moves with it', () => {
        const second = join(DATA_DIR, 'accounts', 'arbeit');

        useAccountDir(second);

        expect(accountDir()).toBe(second);
        // The two that matter most: a shared session file would mean account B reaching Proton as
        // account A, and a shared guard would mean one account's lockout blocking the other.
        expect(join(accountDir(), 'session.enc.json')).toBe(join(second, 'session.enc.json'));
        expect(join(accountDir(), 'login-attempts.json')).toBe(join(second, 'login-attempts.json'));
        expect(join(accountDir(), 'mailbox.db')).toBe(join(second, 'mailbox.db'));
    });

    it('goes back, so a test or a lock leaves nothing pointing at the wrong place', () => {
        useAccountDir(join(DATA_DIR, 'accounts', 'arbeit'));
        useAccountDir(DATA_DIR);

        expect(accountDir()).toBe(DATA_DIR);
    });
});
