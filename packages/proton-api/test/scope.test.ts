import { describe, expect, it } from 'vitest';

import { scopeIsPartial } from '../src/auth.js';

/**
 * Whether a session Proton handed out is finished.
 *
 * The reason this exists is the case the browser login cannot see. An account with a second
 * *factor* reports `TwoFactor` and the login waits for the ceremony; an account with a second
 * *password* reports nothing pending at all, so the login takes the session it is given — and the
 * scope is the only thing that says it is still shut. The failure without this check is a stored
 * session that looks signed in and is refused by every read with HTTP 403.
 *
 * The direction of the doubt matters and runs the other way from most guards here: **unknown is
 * allowed**. Proton's API has no stability guarantee, and refusing a working session on a scope
 * string nobody promised would cost a login — the one thing this project rations.
 */

describe('a scope that says the session is not finished', () => {
    it('catches a session locked behind a second password', () => {
        expect(scopeIsPartial('locked')).toBe(true);
    });

    it('catches one waiting for a second factor', () => {
        expect(scopeIsPartial('twofactor')).toBe(true);
    });
});

describe('a scope that is fine, or unknown', () => {
    it('lets a full session through', () => {
        expect(scopeIsPartial('full')).toBe(false);
        expect(scopeIsPartial('self user loggedin')).toBe(false);
    });

    it('treats a missing scope as unknown rather than as a refusal', () => {
        // Every session stored before the field existed, and every login that involved a second
        // factor. Refusing these would break signing in for everybody who already has.
        expect(scopeIsPartial(undefined)).toBe(false);
        expect(scopeIsPartial('')).toBe(false);
        expect(scopeIsPartial('   ')).toBe(false);
    });

    it('does not refuse a full scope that happens to mention a partial one', () => {
        // The trap in the obvious implementation. A real scope is a list, and Proton includes
        // `nondelinquent` in perfectly good ones — matching on „contains" would refuse them all.
        expect(scopeIsPartial('self user loggedin nondelinquent')).toBe(false);
        expect(scopeIsPartial('locked self user')).toBe(false);
    });
});
