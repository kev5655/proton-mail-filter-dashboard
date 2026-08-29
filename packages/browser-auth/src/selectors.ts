/**
 * Everything about Proton's login page that can change without warning.
 *
 * Kept in one file on purpose. These are the only part of the browser login that is a guess: the
 * endpoints are Proton's published client code, but the markup is a running web app nobody promised
 * to keep stable. When the login breaks, this is the file to look at first, and a changed selector
 * must produce `BROWSER_LOGIN_UI_CHANGED` naming the element rather than a timeout naming nothing.
 */

export const PROTON_LOGIN_URL = 'https://account.proton.me/login';

/** The API path whose response carries the session, relative to the `/api` root. */
export const AUTH_PATH = '/api/core/v4/auth';

export const SELECTORS = {
    username: 'input#username',
    password: 'input#password',
    submit: 'button[type="submit"]',
    totp: 'input#twoFa',
} as const;

export type SelectorName = keyof typeof SELECTORS;
