import { describe, expect, it } from 'vitest';

import '../src/polyfill.js';

/**
 * The one place where a hand-written declaration stands in for real types.
 *
 * `types/protontech-crypto-srp.d.ts` describes `@protontech/crypto/srp` by hand, because that
 * package ships raw TypeScript that will not compile under our settings. A hand-written declaration
 * is a promise the compiler cannot check, so it is checked here at runtime instead: if Proton
 * renames `getSrp` or changes what it returns, this fails loudly rather than the login failing
 * mysteriously in front of the user.
 */

describe('@protontech/crypto/srp boundary', () => {
    it('still exports getSrp with the arity we declare', async () => {
        const srp = await import('@protontech/crypto/srp');
        expect(typeof srp.getSrp).toBe('function');
        // (info, credentials, authVersion) — the third is defaulted, so length is 2.
        expect(srp.getSrp.length).toBe(2);
    });

    it('has the base64 helpers available once our polyfill is imported', () => {
        // @protontech/crypto uses Uint8Array.fromBase64 / .toBase64. Node 24 has neither, so
        // src/polyfill.ts pulls in the polyfill Proton ships. Without it the SRP handshake fails
        // deep inside the library with a message that points nowhere near the real cause.
        expect(typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64).toBe('function');
        expect(typeof new Uint8Array(1).toBase64).toBe('function');
    });
});
