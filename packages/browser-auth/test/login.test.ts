import { isAppError, type AppError } from '@pms/core/errors';
import { describe, expect, it, vi } from 'vitest';

import { loginWithBrowser } from '../src/login.js';
import { SELECTORS, TOTP_SELECTORS } from '../src/selectors.js';

/**
 * The browser login, exercised without a browser.
 *
 * Two things are worth pinning and neither needs Chromium: that the session is taken from Proton's
 * own answer rather than scraped out of the page, and that a changed login page says so instead of
 * timing out. The second matters more than it looks — Proton's markup is the one part of this that
 * nobody promised to keep stable, and a Playwright timeout mentioning a CSS selector reads like a
 * network fault.
 *
 * The password is checked to stay inside: it is typed into a field and must not appear in what
 * comes back or in anything thrown.
 */

const PASSWORD = 'correct-horse-battery-staple';

interface FakePage {
    handlers: Array<(response: unknown) => void>;
    filled: Record<string, string>;
    clicked: string[];
}

function authResponse(body: unknown, path = '/api/core/v4/auth'): unknown {
    return {
        ok: () => true,
        status: () => 200,
        url: () => `https://account.proton.me${path}`,
        request: () => ({ method: () => 'POST' }),
        json: async () => body,
    };
}

// What Proton actually returns to a browser: identity and outcome, no tokens.
const SESSION_BODY = {
    UID: 'uid-1',
    UserID: 'user-1',
    Scope: 'full',
    ServerProof: 'proof',
    TwoFactor: 0,
};

const COOKIE_JAR = [
    { name: 'AUTH-uid-1', value: 'access-1', domain: 'account.proton.me' },
    { name: 'REFRESH-uid-1', value: 'refresh-1', domain: 'account.proton.me' },
    { name: 'Session-Id', value: 'session-1', domain: '.proton.me' },
    { name: 'unrelated', value: 'x', domain: 'example.com' },
];

/**
 * A browser that does nothing but record what was asked of it, and answers with whatever the test
 * decided Proton would say.
 */
function fakeBrowser(
    options: {
        missing?: string;
        body?: unknown;
        twoFactor?: number;
        cookies?: typeof COOKIE_JAR;
        /** Selectors the page does not render until something reveals them. */
        hidden?: string[];
        /** Text of a control that reveals them when clicked. */
        revealedBy?: RegExp;
    } = {}
): {
    launch: () => Promise<never>;
    page: FakePage;
} {
    const page: FakePage = { handlers: [], filled: {}, clicked: [] };
    const body =
        options.body ?? { ...SESSION_BODY, ...(options.twoFactor === undefined ? {} : { TwoFactor: options.twoFactor }) };

    const emit = (): void => {
        for (const handler of page.handlers) {
            handler(authResponse(body));
            if (options.twoFactor !== undefined) {
                handler(authResponse({ Code: 1000 }, '/api/core/v4/auth/2fa'));
            }
        }
    };

    const hidden = new Set(options.hidden ?? []);

    const fakePage = {
        setDefaultTimeout: () => {},
        waitForSelector: async (selector: string) => {
            if (hidden.has(selector)) {
                throw new Error('timeout waiting for selector');
            }
            return {};
        },
        locator: (_selector: string) => ({ all: async () => [] }),
        getByRole: (_role: string, query: { name: RegExp }) => ({
            first: () => ({
                count: async () => (options.revealedBy?.source === query.name.source ? 1 : 0),
                click: async () => {
                    page.clicked.push(query.name.source);
                    hidden.clear();
                },
            }),
        }),
        on: (_event: string, handler: (response: unknown) => void) => page.handlers.push(handler),
        goto: async () => {},
        fill: async (selector: string, value: string) => {
            if (selector === options.missing) {
                throw new Error('locator resolved to no element');
            }
            page.filled[selector] = value;
        },
        click: async (selector: string) => {
            if (selector === options.missing) {
                throw new Error('locator resolved to no element');
            }
            emit();
        },
    };

    const browser = {
        newContext: async () => ({
            pages: () => [],
            newPage: async () => fakePage,
            cookies: async () => options.cookies ?? COOKIE_JAR,
            close: async () => {},
        }),
        close: async () => {},
    };

    return { launch: (async () => browser) as unknown as () => Promise<never>, page };
}

const baseOptions = {
    username: 'someone@proton.me',
    password: PASSWORD,
    promptTotp: async (): Promise<string> => '123456',
    timeoutMs: 1000,
};

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

describe('signing in through a browser', () => {
    it('takes the session out of the cookie jar, since the body has no tokens', async () => {
        // Proton answers a browser in cookie mode. Expecting AccessToken in the body made a
        // successful login look like a broken one for an evening.
        const { launch } = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch });

        expect(result.session.uid).toBe('uid-1');
        expect(result.session.accessToken).toBe('access-1');
        expect(result.session.refreshToken).toBe('refresh-1');
        expect(result.userId).toBe('user-1');
    });

    it('keeps the whole jar, not just the two cookies it recognises', async () => {
        // Sending what the browser would send does not depend on those names staying right.
        const { launch } = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch });

        expect(result.session.cookies).toContain('Session-Id=session-1');
        expect(result.session.cookies).not.toContain('unrelated');
    });

    it('says which cookies exist when the one it needs does not', async () => {
        const { launch } = fakeBrowser({
            cookies: [{ name: 'Session-Id', value: 'session-1', domain: '.proton.me' }],
        });

        const error = await captureError(loginWithBrowser({ ...baseOptions, timeoutMs: 50, launch }));

        expect(error.code).toBe('BROWSER_LOGIN_UI_CHANGED');
        expect(error.context['cookieNames']).toEqual(['Session-Id']);
        expect(JSON.stringify(error.toJSON())).not.toContain('session-1');
    });

    it('types the credentials into the page and returns nothing about them', async () => {
        const { launch, page } = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch });

        expect(page.filled[SELECTORS.password]).toBe(PASSWORD);
        expect(JSON.stringify(result)).not.toContain(PASSWORD);
    });

    it('asks for a code only when Proton says it needs one', async () => {
        const promptTotp = vi.fn(async () => '123456');

        await loginWithBrowser({ ...baseOptions, promptTotp, launch: fakeBrowser().launch });
        expect(promptTotp).not.toHaveBeenCalled();

        await loginWithBrowser({
            ...baseOptions,
            promptTotp,
            launch: fakeBrowser({ twoFactor: 1 }).launch,
        });
        expect(promptTotp).toHaveBeenCalledTimes(1);
    });

    it('switches the second-factor screen to the code before reaching for the field', async () => {
        // Proton opens on the passkey and does not render the code field at all, which is why
        // filling it straight away found nothing and looked like a changed page.
        const switcher = /authentifizierungscode|authentication code/i;
        const { launch, page } = fakeBrowser({
            twoFactor: 1,
            hidden: [...TOTP_SELECTORS],
            revealedBy: switcher,
        });

        await loginWithBrowser({ ...baseOptions, headless: false, launch });

        expect(page.clicked).toContain(switcher.source);
        // Whichever candidate matched first — the point is that a code reached a code field.
        expect(Object.values(page.filled)).toContain('123456');
    });

    it('waits for a person to switch it when no control matches', async () => {
        // Every guess about Proton's markup so far has been wrong. With a visible window the
        // fallback is a person, and that is allowed to be the plan rather than an error.
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [] });

        await expect(
            loginWithBrowser({ ...baseOptions, headless: false, launch })
        ).resolves.toBeDefined();
    });

    it('says so when the code field cannot be reached without a window', async () => {
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [...TOTP_SELECTORS] });

        const error = await captureError(
            loginWithBrowser({ ...baseOptions, headless: true, launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_2FA_UNSUPPORTED');
        expect(error.hint).toMatch(/PMS_BROWSER_HEADLESS=false/);
    });

    it('reports what the page offers when no candidate matches', async () => {
        // Each round of this has cost a login attempt to learn one fact about Proton's markup.
        // The failure has to carry the answer, or the next round costs another.
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [...TOTP_SELECTORS] });

        const error = await captureError(
            loginWithBrowser({ ...baseOptions, headless: false, timeoutMs: 50, launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_TIMEOUT');
        expect(error.context['tried']).toEqual([...TOTP_SELECTORS]);
        expect(error.context).toHaveProperty('inputs');
        expect(error.context).toHaveProperty('buttons');
    });

    it('refuses a passkey without a window to confirm it in', async () => {
        // Headless has no authenticator to touch, so this can only ever fail — say so up front
        // rather than after a two-minute timeout.
        const error = await captureError(
            loginWithBrowser({ ...baseOptions, headless: true, launch: fakeBrowser({ twoFactor: 2 }).launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_2FA_UNSUPPORTED');
        expect(error.hint).toMatch(/sichtbarem Fenster/);
    });

    it('names the field when Protons login page has changed', async () => {
        const error = await captureError(
            loginWithBrowser({ ...baseOptions, launch: fakeBrowser({ missing: SELECTORS.password }).launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_UI_CHANGED');
        expect(error.message).toContain('password');
        expect(error.hint).toContain('selectors.ts');
    });

    it('names the fields that came back, so the next run is not another guess', async () => {
        const error = await captureError(
            loginWithBrowser({
                ...baseOptions,
                launch: fakeBrowser({ body: { Token: 'a-secret-value', Code: 1000 } }).launch,
            })
        );

        expect(error.code).toBe('BROWSER_LOGIN_UI_CHANGED');
        expect(error.context['fields']).toEqual(['Code', 'Token']);
        expect(error.context['missing']).toContain('UID');
    });

    it('reports those field names without their values', async () => {
        // One of the fields we are hoping for is an access token; printing the object would print it.
        const error = await captureError(
            loginWithBrowser({
                ...baseOptions,
                launch: fakeBrowser({ body: { Token: 'a-secret-value', Code: 1000 } }).launch,
            })
        );

        expect(JSON.stringify(error.toJSON())).not.toContain('a-secret-value');
    });

    it('keeps the password out of a failure', async () => {
        const error = await captureError(
            loginWithBrowser({ ...baseOptions, launch: fakeBrowser({ missing: SELECTORS.password }).launch })
        );

        expect(JSON.stringify(error.toJSON())).not.toContain(PASSWORD);
    });
});
