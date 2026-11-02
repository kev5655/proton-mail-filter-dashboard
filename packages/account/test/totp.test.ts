import { describe, expect, it } from 'vitest';

import { newTotpSecret, totpCode, totpUri, verifyTotp } from '../src/totp.js';

/**
 * TOTP, checked against the published vectors rather than against itself.
 *
 * Implementing this by hand is defensible precisely because it can be verified this way: RFC 6238
 * ships test vectors, and a wrong implementation fails them immediately. That is not true of
 * WebAuthn, which is why that one uses a library.
 */

// RFC 6238 appendix B, SHA-1: the secret is the ASCII "12345678901234567890", which is
// "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('the published vectors', () => {
    it.each([
        [59, '287082'],
        [1_111_111_109, '081804'],
        [1_111_111_111, '050471'],
        [1_234_567_890, '005924'],
        [2_000_000_000, '279037'],
    ])('at t=%i produces %s', (seconds, expected) => {
        expect(totpCode(RFC_SECRET, seconds)).toBe(expected);
    });
});

describe('verifying a code', () => {
    const now = 1_700_000_000;

    it('accepts the current one', () => {
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(true);
    });

    it('accepts one that has just rolled over, because people finish typing', () => {
        // Zero tolerance produces „der Code ist falsch" for a code that was right a second ago,
        // which teaches people to distrust the feature rather than their clock.
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30), now)).toBe(true);
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30), now)).toBe(true);
    });

    it('refuses one from outside the window', () => {
        expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 120), now)).toBe(false);
    });

    it('refuses anything that is not six digits, without hashing it', () => {
        for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
            expect(verifyTotp(RFC_SECRET, bad, now), bad).toBe(false);
        }
    });

    it('ignores the spaces authenticator apps put in', () => {
        const code = totpCode(RFC_SECRET, now);
        expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
    });
});

describe('a new secret', () => {
    it('is base32 an app can read', () => {
        expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    });

    it('is different every time', () => {
        expect(newTotpSecret()).not.toBe(newTotpSecret());
    });

    it('round-trips through its own code generator', () => {
        const secret = newTotpSecret();
        expect(verifyTotp(secret, totpCode(secret, 1_700_000_000), 1_700_000_000)).toBe(true);
    });
});

describe('the URI an authenticator scans', () => {
    it('names the issuer twice, because that is what the apps read', () => {
        // Getting this wrong shows up as an entry called after the account with no clue which tool
        // it belongs to — discovered later, on a phone, by somebody locked out.
        const uri = totpUri('ABCDEFGH', 'kevin@example.com');

        expect(uri).toContain('otpauth://totp/Proton%20Mail%20Sorter%3Akevin%40example.com');
        expect(uri).toContain('issuer=Proton+Mail+Sorter');
        expect(uri).toContain('secret=ABCDEFGH');
    });
});
