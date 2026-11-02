/**
 * Whether this browser has ever opened this account.
 *
 * The lock screen must not treat whoever loaded the page as the owner. It is a page anybody on the
 * tailnet can reach, and greeting them by the account's name — „angemeldet wird als …" — tells them
 * something about a mailbox they have not proven they can open, on the strength of nothing but
 * having asked for the page.
 *
 * So there are two screens, and this is what separates them. A device that has unlocked before is
 * one the account holder has been sitting at, and it may say so. A device that has not is a
 * stranger until the authenticator or the password says otherwise.
 *
 * It holds no secret and grants nothing: forging it produces a friendlier sentence and not one byte
 * of access. That is the whole reason it is allowed to be a browser flag rather than something the
 * server has to vouch for.
 */

const KEY = 'pms.device.known';

/** True where this browser has completed an unlock before. Never a reason to skip one. */
export function deviceIsKnown(): boolean {
    try {
        return window.localStorage.getItem(KEY) === '1';
    } catch {
        // A private window, cleared site data, or a browser set to refuse storage. „Unknown" is the
        // right reading of every one of those, and it is also the safe one.
        return false;
    }
}

/** Remember that an unlock succeeded here. Called after the fact, never before. */
export function rememberDevice(): void {
    try {
        window.localStorage.setItem(KEY, '1');
    } catch {
        // Nothing depends on this sticking; the next visit simply reads as a first one.
    }
}
