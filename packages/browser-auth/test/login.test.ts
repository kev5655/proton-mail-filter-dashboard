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
        /** The submit button disappears once this many clicks have landed. */
        submitVanishesAfter?: number;
        /**
         * The access cookie is re-issued after this many reads of the jar, as Proton does once a
         * second factor has been answered. Absent means it never changes — the window was left
         * sitting on the login screen.
         */
        upgradeAfter?: number;
        /** The path the browser is on. `/login` until something says otherwise. */
        url?: string;
    } = {}
): {
    launch: () => Promise<never>;
    page: FakePage;
} {
    const page: FakePage = { handlers: [], filled: {}, clicked: [] };
    let jarReads = 0;
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

    /**
     * The control that switches the second-factor screen to the code field.
     *
     * Only `revealedBy` exists; everything else counts zero. `role` is ignored on purpose — the
     * test says *what* is on the page, and which of button/link/text finds it is exactly the part
     * the code is allowed to change without the test being rewritten.
     */
    const switchLocator = (
        role: string,
        pattern: RegExp
    ): { count: () => Promise<number>; first: () => { click: () => Promise<void> } } => {
        const present = options.revealedBy?.source === pattern.source;
        const click = async (): Promise<void> => {
            page.clicked.push(`${role}:${pattern.source}`);
            hidden.clear();
        };
        return {
            count: async () => (present ? 1 : 0),
            first: () => ({ click }),
        };
    };

    const fakePage = {
        setDefaultTimeout: () => {},
        waitForSelector: async (selector: string) => {
            if (hidden.has(selector)) {
                throw new Error('timeout waiting for selector');
            }
            return {};
        },
        locator: (selector: string) => ({
            all: async () => [],
            first: () => ({
                click: async () => {
                    const gone =
                        selector === options.missing ||
                        (options.submitVanishesAfter !== undefined &&
                            page.clicked.length >= options.submitVanishesAfter);
                    if (gone) {
                        throw new Error('locator resolved to no element');
                    }
                    page.clicked.push(selector);
                    emit();
                },
            }),
        }),
        // Shaped like a Playwright locator: `count()` and `click()` both hang off it, and `first()`
        // returns another locator rather than a different kind of thing. The code under test calls
        // them in that order, and a fake that only offered `first()` let a wrong call sequence pass.
        getByRole: (role: string, query: { name: RegExp }) => switchLocator(role, query.name),
        getByText: (pattern: RegExp) => switchLocator('text', pattern),
        on: (_event: string, handler: (response: unknown) => void) => page.handlers.push(handler),
        url: () => `https://account.proton.me${options.url ?? '/login'}`,
        goto: async () => {},
        fill: async (selector: string, value: string) => {
            if (selector === options.missing) {
                throw new Error('locator resolved to no element');
            }
            page.filled[selector] = value;
        },
    };

    const browser = {
        newContext: async () => ({
            pages: () => [],
            newPage: async () => fakePage,
            cookies: async () => {
                jarReads++;
                const jar = options.cookies ?? COOKIE_JAR;
                if (options.upgradeAfter === undefined || jarReads <= options.upgradeAfter) {
                    return jar;
                }
                // What Proton does once the factor is answered: a new access token, same session.
                return jar.map((cookie) =>
                    cookie.name === 'AUTH-uid-1' ? { ...cookie, value: 'access-full' } : cookie
                );
            },
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
            launch: fakeBrowser({ twoFactor: 1, upgradeAfter: 1 }).launch,
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
            // The factor is answered here, so the session is upgraded — otherwise this test would
            // be asserting the switch on a login that never finished.
            upgradeAfter: 1,
        });

        await loginWithBrowser({ ...baseOptions, headless: false, launch });

        // By its wording, not by the role it was found under: the control is a button today and
        // has already been something else once, and pinning the role here would turn a working
        // fallback into a failing test.
        expect(page.clicked.some((entry) => entry.endsWith(switcher.source))).toBe(true);
        // Whichever candidate matched first — the point is that a code reached a code field.
        expect(Object.values(page.filled)).toContain('123456');
    });

    it('waits for a person to switch it when no control matches', async () => {
        // Every guess about Proton's markup so far has been wrong. With a visible window the
        // fallback is a person, and that is allowed to be the plan rather than an error.
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [], upgradeAfter: 1 });

        await expect(
            loginWithBrowser({ ...baseOptions, headless: false, launch })
        ).resolves.toBeDefined();
    });

    it('says so when the code field cannot be reached without a window', async () => {
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [...TOTP_SELECTORS], upgradeAfter: 1 });

        const error = await captureError(
            loginWithBrowser({ ...baseOptions, headless: true, launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_2FA_UNSUPPORTED');
        expect(error.hint).toMatch(/PMS_BROWSER_HEADLESS=false/);
    });

    it('reports what the page offers when no candidate matches', async () => {
        // Each round of this has cost a login attempt to learn one fact about Proton's markup.
        // The failure has to carry the answer, or the next round costs another.
        const { launch } = fakeBrowser({ twoFactor: 1, hidden: [...TOTP_SELECTORS], upgradeAfter: 1 });

        const error = await captureError(
            loginWithBrowser({ ...baseOptions, headless: false, timeoutMs: 50, launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_TIMEOUT');
        expect(error.context['tried']).toEqual([...TOTP_SELECTORS]);
        expect(error.context).toHaveProperty('inputs');
        expect(error.context).toHaveProperty('buttons');
    });

    it('does not fail when the code field submitted itself', async () => {
        // A six-digit field usually submits on the sixth digit, so by the time the button is
        // pressed there is no button. That is the form having worked, not a broken page.
        const { launch } = fakeBrowser({ twoFactor: 1, submitVanishesAfter: 1, upgradeAfter: 1 });

        await expect(
            loginWithBrowser({ ...baseOptions, headless: false, launch })
        ).resolves.toBeDefined();
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

/**
 * The bug that cost Kevin a sync, and the two signals that replace the one that was wrong.
 *
 * Proton sets `AUTH-<UID>` on the answer to `core/v4/auth` — *before* a second factor. Waiting for
 * that cookie to exist therefore returned immediately with a session whose scope was still partial,
 * and the failure surfaced minutes later as „HTTP 403, access token does not have sufficient scope"
 * on a mailbox read, on a screen that said nothing about logging in.
 *
 * So with a factor pending the cookie's presence proves nothing, and the login is over when the
 * access cookie is re-issued or the browser leaves the login page. Both are checked here, and so is
 * the case where neither happens: that must fail, and it must fail saying which.
 */
describe('a login with a second factor', () => {
    it('waits for the upgraded session rather than the first cookie', async () => {
        const fake = fakeBrowser({ twoFactor: 1, upgradeAfter: 1 });

        const result = await loginWithBrowser({ ...baseOptions, launch: fake.launch });

        // `access-1` is the token from before the factor — the one that cannot read a label.
        expect(result.session.accessToken).toBe('access-full');
    });

    it('accepts the session once the browser has left the login page', async () => {
        // The other signal, for the day Proton stops re-issuing the cookie. Without it, a login
        // that really did finish would sit here until the timeout and cost an attempt.
        const fake = fakeBrowser({ twoFactor: 1, url: '/u/0/inbox' });

        const result = await loginWithBrowser({ ...baseOptions, launch: fake.launch });

        expect(result.session.accessToken).toBe('access-1');
    });

    it('refuses the partial session, and says the factor was not confirmed', async () => {
        // Neither signal: the window was left on the login screen. Taking the cookie here is what
        // produced the 403 — so it has to be a refusal, and one that names the real cause.
        const fake = fakeBrowser({ twoFactor: 1 });

        const error = await captureError(loginWithBrowser({ ...baseOptions, launch: fake.launch }));

        expect(error.code).toBe('BROWSER_LOGIN_UNFINISHED');
        expect(error.message).toContain('zweite Faktor');
        expect(JSON.stringify(error)).not.toContain(PASSWORD);
    });
});

describe('a login with nothing pending', () => {
    it('takes the cookie as soon as it is there', async () => {
        // Unchanged, and deliberately so: with no factor to come, that cookie *is* the session.
        // Making this wait for a change too would hang every login on an account without 2FA.
        const fake = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch: fake.launch });

        expect(result.session.accessToken).toBe('access-1');
    });

    it('records the scope, because there it is the final word', async () => {
        const fake = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch: fake.launch });

        expect(result.session.scope).toBe('full');
    });

    it('records no scope where a factor was pending, rather than the pre-factor one', async () => {
        // „locked" was true before the factor and false after it. Storing it would put a stale
        // claim behind a field name, and the guard that reads it would refuse a working session.
        const fake = fakeBrowser({ twoFactor: 1, upgradeAfter: 1, body: { ...SESSION_BODY, Scope: 'locked', TwoFactor: 1 } });

        const result = await loginWithBrowser({ ...baseOptions, launch: fake.launch });

        expect(result.session.scope).toBeUndefined();
    });
});
