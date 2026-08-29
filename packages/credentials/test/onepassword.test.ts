import { isAppError, type AppError } from '@pms/core/errors';
import { describe, expect, it, vi } from 'vitest';

import { createOnePasswordSource, describeItem } from '../src/onepassword.js';

/**
 * Credentials from 1Password.
 *
 * The theme of every test here is the one that already cost a lockout: a credential source can hand
 * back nothing, or hand back a message where a value belongs, and neither looks like an error at
 * the call site. Anything that reaches Proton and is not a real credential costs a login attempt.
 *
 * So the suite is mostly about what must *not* happen — no empty value passed on, no error text
 * mistaken for a password, and no secret in a log line or an error message.
 */

const VAULT = 'Kevin Private';
const ITEM = 'Proton';

function opFails(stderr: string, code: string | number = 1): () => Promise<string> {
    return () => Promise.reject(Object.assign(new Error('op failed'), { stderr, code }));
}

function sourceWith(run: (args: string[]) => Promise<string>): ReturnType<typeof createOnePasswordSource> {
    return createOnePasswordSource({ vault: VAULT, item: ITEM, run });
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
    try {
        await promise;
        throw new Error('expected a failure');
    } catch (error) {
        if (!isAppError(error)) {
            throw error;
        }
        return error;
    }
}

describe('reading credentials', () => {
    it('reads username and password from the expected fields', async () => {
        const run = vi.fn(async (args: string[]) =>
            args[1]?.endsWith('/password') === true ? 'correct-horse' : 'kevin@proton.me'
        );
        const source = sourceWith(run);

        expect(await source.getUsername()).toBe('kevin@proton.me');
        expect(await source.getPassword()).toBe('correct-horse');
        expect(run).toHaveBeenCalledWith(['read', `op://${VAULT}/${ITEM}/username`]);
    });

    it('falls back to the next field label when the first is absent', async () => {
        const run = vi.fn(async (args: string[]) => {
            if (args[1]?.endsWith('/username') === true) {
                throw Object.assign(new Error('x'), { stderr: 'no such field "username"' });
            }
            return 'kevin@proton.me';
        });

        expect(await sourceWith(run).getUsername()).toBe('kevin@proton.me');
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('strips the trailing newline the CLI adds', async () => {
        expect(await sourceWith(async () => 'kevin@proton.me\n').getUsername()).toBe('kevin@proton.me');
    });

    it('passes --account when several op accounts are signed in', async () => {
        const run = vi.fn(async () => 'kevin@proton.me');
        const source = createOnePasswordSource({ vault: VAULT, item: ITEM, account: 'my.1password.eu', run });

        await source.getUsername();

        expect(run).toHaveBeenCalledWith([
            'read',
            `op://${VAULT}/${ITEM}/username`,
            '--account',
            'my.1password.eu',
        ]);
    });
});

describe('refusing to pass on a non-credential', () => {
    it('rejects an empty password instead of sending it to Proton', async () => {
        // The exact failure that led to the lockout, arriving from a different source.
        const error = await captureError(sourceWith(async () => '').getPassword());

        expect(error.code).toBe('CREDENTIALS_EMPTY');
        expect(error.hint).toMatch(/Kontosperre/);
    });

    it('rejects whitespace, which is empty in every way that matters', async () => {
        const error = await captureError(sourceWith(async () => '   \n  ').getPassword());
        expect(error.code).toBe('CREDENTIALS_EMPTY');
    });

    it('rejects a multi-line blob that is clearly not a password', async () => {
        const error = await captureError(
            sourceWith(async () => '[ERROR] could not read item\nsee docs').getPassword()
        );
        expect(error.code).toBe('CREDENTIALS_MALFORMED');
    });

    it('rejects a username containing spaces or newlines', async () => {
        const error = await captureError(sourceWith(async () => 'not a username').getUsername());
        expect(error.code).toBe('CREDENTIALS_MALFORMED');
    });

    it('accepts a valid TOTP and rejects anything that is not one', async () => {
        expect(await sourceWith(async () => '123456\n').getTotp()).toBe('123456');
        expect(await sourceWith(async () => '123 456').getTotp()).toBe('123456');

        const error = await captureError(sourceWith(async () => 'no otp configured').getTotp());
        expect(error.code).toBe('CREDENTIALS_MALFORMED');
    });

    it('returns undefined when the item simply has no TOTP, so the caller can prompt', async () => {
        expect(await sourceWith(opFails('no such field: one-time password')).getTotp()).toBeUndefined();
        expect(await sourceWith(async () => '').getTotp()).toBeUndefined();
    });
});

describe('diagnosing a misconfiguration', () => {
    it('names the missing field and points at the describe command', async () => {
        const error = await captureError(sourceWith(opFails('no such field')).getPassword());

        expect(error.code).toBe('CREDENTIALS_NOT_FOUND');
        expect(error.hint).toContain('--describe-1password');
        expect(error.context['triedFields']).toEqual(['password']);
    });

    it('reports a locked vault as locked, not as a missing entry', async () => {
        const error = await captureError(
            sourceWith(opFails('error: you are not currently signed in')).getPassword()
        );
        expect(error.code).toBe('CREDENTIALS_LOCKED');
        expect(error.hint).toMatch(/op signin/);
    });

    it('reports a missing CLI as a missing CLI', async () => {
        const error = await captureError(sourceWith(opFails('', 'ENOENT')).getPassword());
        expect(error.code).toBe('CREDENTIALS_TOOL_MISSING');
    });

    it('reports a wrong item or vault name plainly', async () => {
        const error = await captureError(
            sourceWith(opFails('"Protom" isn\'t an item in the "Kevin Private" vault')).getPassword()
        );
        expect(error.code).toBe('CREDENTIALS_NOT_FOUND');
        expect(error.message).toContain(ITEM);
    });

    it('lists field labels without revealing a single value', async () => {
        const json = JSON.stringify({
            fields: [
                { id: 'username', label: 'username', type: 'STRING', value: 'kevin@proton.me' },
                { id: 'password', label: 'password', type: 'CONCEALED', value: 'super-secret' },
            ],
        });
        const labels = await describeItem({ vault: VAULT, item: ITEM, run: async () => json });

        expect(labels).toEqual(['username (STRING)', 'password (CONCEALED)']);
        expect(labels.join()).not.toContain('super-secret');
        expect(labels.join()).not.toContain('kevin@proton.me');
    });
});

describe('not leaking the secret', () => {
    it('keeps the value out of every error it raises', async () => {
        const secret = 'super-secret-password-value';
        const error = await captureError(
            sourceWith(async () => `${secret}\nand a second line`).getPassword()
        );

        expect(JSON.stringify(error.toJSON())).not.toContain(secret);
    });
});

describe('the session passphrase', () => {
    it('is read from its own field, not the account password', async () => {
        // A different thing is being protected: the tokens on this machine, not the account.
        // Reusing the Proton password would make one value unlock both.
        const run = vi.fn(async (args: string[]) =>
            args[1]?.endsWith('/session-passphrase') === true ? 'lange-zufaellige-passphrase' : 'anderes'
        );

        expect(await sourceWith(run).getSessionPassphrase()).toBe('lange-zufaellige-passphrase');
        expect(run).toHaveBeenCalledWith(['read', `op://${VAULT}/${ITEM}/session-passphrase`]);
    });

    it('returns undefined when the item has no such field, so the caller can ask', async () => {
        // A missing field is a normal state, not a failure — the user simply has not created one.
        expect(await sourceWith(opFails('no such field')).getSessionPassphrase()).toBeUndefined();
        expect(await sourceWith(async () => '   ').getSessionPassphrase()).toBeUndefined();
    });

    it('still reports a locked vault rather than silently falling back to a prompt', async () => {
        // Falling back here would be the wrong kindness: the user would type a passphrase that
        // does not match the one the session was encrypted with, and see a decryption failure.
        const error = await captureError(
            sourceWith(opFails('error: you are not currently signed in')).getSessionPassphrase()
        );
        expect(error.code).toBe('CREDENTIALS_LOCKED');
    });
});
