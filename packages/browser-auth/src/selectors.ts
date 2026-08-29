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

/**
 * Wording that switches the second-factor screen from passkey to authenticator code.
 *
 * Proton offers a passkey first and keeps the code field hidden behind a link, so reaching for the
 * field directly finds nothing. Matched by visible text rather than by a class or id: the words are
 * what Proton is least likely to change silently, and getting this wrong is only a lost click —
 * the run then waits for the field and the person switches it themselves.
 */
export const TOTP_SWITCH_PATTERNS = [
    /authentifizierungscode|authentication code/i,
    /authenticator/i,
    /einmalcode|one-time code|verification code/i,
    /andere methode|another method|different method/i,
] as const;

export type SelectorName = keyof typeof SELECTORS;
