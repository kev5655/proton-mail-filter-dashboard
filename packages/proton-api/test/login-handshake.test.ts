import { isAppError, type AppError } from '@pms/core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/crypto.js', () => ({ initCrypto: (): void => {}, releaseCrypto: (): void => {} }));
vi.mock('@protontech/crypto/srp', () => ({
    getSrp: async () => ({
        clientEphemeral: 'ephemeral',
        clientProof: 'proof',
        expectedServerProof: 'server-proof',
    }),
}));

const { login } = await import('../src/auth.js');
const { ProtonHttp } = await import('../src/http.js');

/**
 * The shape of the login handshake, as opposed to whether it succeeds.
 *
 * This is the regression that cost a real account a lockout. The credentials were fine and the
 * cryptography was fine; what Proton objected to was the *shape* — two SRP calls arriving with no
 * session context, which is what credential stuffing looks like from the outside. Proton answered
 * with code 2028 while the same account signed in through a browser without trouble.
 *
 * Nothing here talks to Proton. The point is precisely that the sequence can be pinned without
 * spending an attempt, because attempts are what made this expensive.
 */

interface Call {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

let calls: Call[];

function respond(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

const UNAUTH_UID = 'unauth-uid';

function fakeProton(overrides: { sessionFails?: boolean } = {}): typeof fetch {
    return (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        calls.push({
            url,
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });

        if (url.endsWith('auth/v4/sessions')) {
            if (overrides.sessionFails === true) {
                return new Response(JSON.stringify({ Code: 2028, Error: 'nope' }), { status: 422 });
            }
            return respond({
                Code: 1000,
                UID: UNAUTH_UID,
                AccessToken: 'unauth-access',
                RefreshToken: 'unauth-refresh',
            });
        }
        if (url.endsWith('core/v4/auth/info')) {
            return respond({
                Code: 1000,
                Modulus: 'modulus',
                ServerEphemeral: 'server-ephemeral',
                Version: 4,
                Salt: 'salt',
                SRPSession: 'srp-session',
            });
        }
        if (url.endsWith('core/v4/auth')) {
            return respond({
                Code: 1000,
                AccessToken: 'real-access',
                RefreshToken: 'real-refresh',
                UID: 'real-uid',
                UserID: 'user-1',
                Scope: 'full',
                ExpiresIn: 3600,
                TwoFactor: 0,
                ServerProof: 'server-proof',
            });
        }
        throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
}

function http(fetchImpl: typeof fetch): InstanceType<typeof ProtonHttp> {
    return new ProtonHttp({ version: '0.0.0', fetchImpl, maxAttempts: 1 });
}

const credentials = { username: 'someone@proton.me', password: 'correct-horse' };
const noTwoFactor = async (): Promise<string> => {
    throw new Error('2FA should not be requested');
};

beforeEach(() => {
    calls = [];
});

describe('the login handshake', () => {
    it('opens an unauthenticated session before it sends anything about the user', async () => {
        await login(http(fakeProton()), credentials, noTwoFactor);

        expect(calls.map((call) => call.url.replace(/^.*\/api\//, ''))).toEqual([
            'auth/v4/sessions',
            'core/v4/auth/info',
            'core/v4/auth',
        ]);

        // The username must not appear before Proton has given us a session to present it in.
        expect(JSON.stringify(calls[0]?.body)).not.toContain(credentials.username);
    });

    it('runs both SRP calls inside that session', async () => {
        // The whole point: Proton sees one client having one conversation, not two bare submissions.
        await login(http(fakeProton()), credentials, noTwoFactor);

        expect(calls[1]?.headers['x-pm-uid']).toBe(UNAUTH_UID);
        expect(calls[2]?.headers['x-pm-uid']).toBe(UNAUTH_UID);
    });

    it('asks to be held to the unauth-session rule rather than exempted from it', async () => {
        await login(http(fakeProton()), credentials, noTwoFactor);
        expect(calls[0]?.headers['x-enforce-unauthsession']).toBe('true');
    });

    it('sends no device challenge, because we are not a browser', async () => {
        await login(http(fakeProton()), credentials, noTwoFactor);
        expect(calls[0]?.body).not.toHaveProperty('Payload');
    });

    it('stops before the password when no session can be opened', async () => {
        // Falling back to the old anonymous shape would recreate the pattern Proton flagged, and
        // would spend a login attempt doing it.
        const error = await login(http(fakeProton({ sessionFails: true })), credentials, noTwoFactor).then(
            () => undefined,
            (caught: unknown) => (isAppError(caught) ? caught : undefined)
        );

        expect(error?.code).toBe('PROTON_AUTH_FAILED');
        expect((error as AppError).hint).toMatch(/kein Fehlversuch/);
        expect(calls).toHaveLength(1);
    });

    it('replaces the throwaway session with the real one once authenticated', async () => {
        const client = http(fakeProton());
        await login(client, credentials, noTwoFactor);

        expect(client.session?.uid).toBe('real-uid');
        expect(client.session?.accessToken).toBe('real-access');
    });
});
