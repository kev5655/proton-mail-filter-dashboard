import { isAppError, type AppError } from '@pms/core/errors';
import { describe, expect, it, vi } from 'vitest';

import { loginWithBrowser } from '../src/login.js';
import { SELECTORS } from '../src/selectors.js';

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
}

function authResponse(body: unknown, path = '/api/core/v4/auth'): unknown {
    return {
        ok: () => true,
        url: () => `https://account.proton.me${path}`,
        request: () => ({ method: () => 'POST' }),
        json: async () => body,
    };
}

const SESSION_BODY = {
    UID: 'uid-1',
    AccessToken: 'access-1',
    RefreshToken: 'refresh-1',
    UserID: 'user-1',
    TwoFactor: 0,
};

/**
 * A browser that does nothing but record what was asked of it, and answers with whatever the test
 * decided Proton would say.
 */
function fakeBrowser(options: { missing?: string; body?: unknown; twoFactor?: number } = {}): {
    launch: () => Promise<never>;
    page: FakePage;
} {
    const page: FakePage = { handlers: [], filled: {} };
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

    const fakePage = {
        setDefaultTimeout: () => {},
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
    it('takes the session from Protons own answer', async () => {
        const { launch } = fakeBrowser();

        const result = await loginWithBrowser({ ...baseOptions, launch });

        expect(result.session).toEqual({
            uid: 'uid-1',
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
        });
        expect(result.userId).toBe('user-1');
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

    it('says the answer was wrong rather than guessing when the fields are unfamiliar', async () => {
        const error = await captureError(
            loginWithBrowser({ ...baseOptions, launch: fakeBrowser({ body: { Token: 'something-else' } }).launch })
        );

        expect(error.code).toBe('BROWSER_LOGIN_UI_CHANGED');
    });

    it('keeps the password out of a failure', async () => {
        const error = await captureError(
            loginWithBrowser({ ...baseOptions, launch: fakeBrowser({ missing: SELECTORS.password }).launch })
        );

        expect(JSON.stringify(error.toJSON())).not.toContain(PASSWORD);
    });
});
