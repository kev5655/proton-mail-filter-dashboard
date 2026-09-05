import { AppError } from '@pms/core/errors';
import { describe, expect, it } from 'vitest';

import { AccountChannel, route, type AccountRunner, type AccountView, type Reply } from '../src/index.js';

/**
 * The gate, and the two things about it that are easy to get wrong.
 *
 * The first is what a locked server says. „Nothing here" and „not unlocked yet" are different
 * states, and a dashboard that cannot tell them apart either hides a lock screen behind an empty
 * mailbox or puts one in front of a server that has no account at all.
 *
 * The second is the challenge. A WebAuthn verification that used the browser's copy of the
 * challenge would verify nothing — the response and the question it answers would both come from
 * the same untrusted place. So the server keeps it, hands it to the verifier itself, and spends it
 * once.
 */

const VIEW: AccountView = {
    available: true,
    registered: true,
    unlocked: false,
    username: 'kevin',
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 30,
    withinGrace: false,
    ready: false,
};

function runner(overrides: Partial<AccountRunner> = {}): AccountRunner {
    return {
        view: () => VIEW,
        register: async () => undefined,
        unlock: async () => undefined,
        resume: async () => undefined,
        confirmChange: async () => undefined,
        declineChange: async () => undefined,
        lock: () => undefined,
        changePassword: async () => undefined,
        beginTotp: async () => ({ secret: 'AAAA', uri: 'otpauth://x' }),
        enableTotp: async () => undefined,
        disableTotp: async () => undefined,
        beginPasskeyRegistration: async () => ({ challenge: 'server-side-challenge', options: {} }),
        finishPasskeyRegistration: async () => undefined,
        removePasskey: async () => undefined,
        beginPasskeyLogin: async () => ({ challenge: 'server-side-challenge', options: {} }),
        setGraceMinutes: async () => undefined,
        ...overrides,
    };
}

async function post(channel: AccountChannel, body: unknown): Promise<Reply> {
    return (await route('POST', '/api/account', undefined, { account: channel }, body)) as Reply;
}

describe('a locked server', () => {
    it('says the mailbox is locked rather than answering with an empty one', () => {
        const reply = route('GET', '/api/mailbox', undefined, {
            account: new AccountChannel(runner()),
        }) as Reply;

        expect(reply.status).toBe(423);
        expect((reply.body as { code: string }).code).toBe('ACCOUNT_LOCKED');
    });

    it('shows no lock at all when the server has no account surface', () => {
        // An older server, or one started without one. A dashboard must not put a password field in
        // front of a mailbox that is being served perfectly well.
        const reply = route('GET', '/api/account', undefined, {}) as Reply;

        expect(reply.status).toBe(200);
        expect(reply.body).toMatchObject({ available: false, registered: false, ready: true });
    });

    it('refuses an account action when there is nothing to act on', () => {
        const reply = route('POST', '/api/account', undefined, {}, { action: 'unlock' }) as Reply;

        expect(reply.status).toBe(503);
    });
});

describe('the account surface', () => {
    it('refuses an action it does not know, rather than doing the nearest one', async () => {
        const reply = await post(new AccountChannel(runner()), { action: 'delete-everything' });

        expect(reply.status).toBe(400);
        expect((reply.body as { code: string }).code).toBe('ACCOUNT_UNKNOWN_ACTION');
    });

    it('answers a wrong password with 401 and the code, and never echoes the password', async () => {
        const channel = new AccountChannel(
            runner({
                unlock: async () => {
                    throw new AppError('ACCOUNT_PASSWORD_WRONG', {
                        message: 'Das Passwort stimmt nicht.',
                        hint: 'Es wurde nichts aufgeschlossen.',
                    });
                },
            })
        );

        const reply = await post(channel, { action: 'unlock', password: 'hunter2' });

        expect(reply.status).toBe(401);
        expect(JSON.stringify(reply.body)).not.toContain('hunter2');
    });

    it('reports the state after every action, so the dashboard needs no second request', async () => {
        const reply = await post(new AccountChannel(runner()), { action: 'lock' });

        expect(reply.body).toMatchObject({ registered: true, unlocked: false });
    });
});

describe('answering a pending change', () => {
    it('passes the password on to be checked, and nothing else', async () => {
        const seen: Array<{ requestId: string; password: string }> = [];
        const channel = new AccountChannel(
            runner({
                confirmChange: async (requestId, password) => {
                    seen.push({ requestId, password });
                },
            })
        );

        await post(channel, { action: 'confirm-change', requestId: 'req-1', password: 'geheim' });

        expect(seen).toEqual([{ requestId: 'req-1', password: 'geheim' }]);
    });

    it('refuses without asking for a password, because saying no proves nothing', async () => {
        // The only way to refuse used to be to let the five minutes run out, which left the change
        // armed for exactly as long as somebody might step away from the screen.
        const declined: string[] = [];
        const granted: string[] = [];
        const channel = new AccountChannel(
            runner({
                confirmChange: async (requestId) => {
                    granted.push(requestId);
                },
                declineChange: async (requestId) => {
                    declined.push(requestId);
                },
            })
        );

        await post(channel, { action: 'confirm-change', requestId: 'req-1', decline: true });

        expect(declined).toEqual(['req-1']);
        expect(granted).toEqual([]);
    });

    it('does not take a stray `decline` string for a refusal', async () => {
        // Anything but `true` is a malformed request, and the safe reading of one is the branch
        // that grants nothing — which here means falling through to the password check.
        const declined: string[] = [];
        const channel = new AccountChannel(
            runner({
                declineChange: async (requestId) => {
                    declined.push(requestId);
                },
                confirmChange: async () => {
                    throw new AppError('APPLY_NOT_CONFIRMED', { message: 'falsches Passwort' });
                },
            })
        );

        const reply = await post(channel, { action: 'confirm-change', requestId: 'req-1', decline: 'ja' });

        expect(declined).toEqual([]);
        expect(reply.status).not.toBe(200);
    });
});

describe('the passkey challenge', () => {
    it('is the server’s, not the one the browser sends back', async () => {
        let seen: string | undefined;
        const channel = new AccountChannel(
            runner({
                finishPasskeyRegistration: async (input) => {
                    seen = input.challenge;
                },
            })
        );

        await post(channel, { action: 'passkey-register-begin', origin: 'http://localhost:5173' });
        await post(channel, {
            action: 'passkey-register-finish',
            label: 'YubiKey',
            // What a forged client would like to be verified against.
            challenge: 'anything-i-want',
            response: { id: 'abc' },
        });

        expect(seen).toBe('server-side-challenge');
    });

    it('is spent once, so a replayed response has nothing to answer', async () => {
        const channel = new AccountChannel(runner());

        await post(channel, { action: 'passkey-register-begin', origin: 'http://localhost:5173' });
        const first = await post(channel, { action: 'passkey-register-finish', response: {} });
        const replay = await post(channel, { action: 'passkey-register-finish', response: {} });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(400);
        expect((replay.body as { code: string }).code).toBe('ACCOUNT_NO_CHALLENGE');
    });

    it('refuses a finish that was never begun', async () => {
        const reply = await post(new AccountChannel(runner()), {
            action: 'passkey-register-finish',
            response: {},
        });

        expect((reply.body as { code: string }).code).toBe('ACCOUNT_NO_CHALLENGE');
    });
});
