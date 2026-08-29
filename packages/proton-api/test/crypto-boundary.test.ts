import { describe, expect, it } from 'vitest';

import { getSrp } from '@protontech/crypto/srp';

import { initCrypto, releaseCrypto } from '../src/crypto.js';
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

    it('initCrypto makes the proxy usable, so SRP fails on the input rather than on setup', async () => {
        // Before this was wired up, the first real login died with "CryptoProxy: endpoint not
        // initialized" from four frames inside the library. After initCrypto, a bad modulus must
        // fail as a bad modulus — that difference is the whole point.
        initCrypto();
        try {
            await expect(
                getSrp(
                    {
                        Version: 4,
                        Modulus: 'not a signed pgp message',
                        ServerEphemeral: '',
                        Username: 'someone@example.com',
                        Salt: '',
                    },
                    { username: 'someone@example.com', password: 'irrelevant' }
                )
            ).rejects.toThrow(/^(?!.*endpoint not initialized).*$/s);
        } finally {
            await releaseCrypto();
        }
    });

    it('is idempotent, so a second login does not re-register the endpoint', () => {
        expect(() => {
            initCrypto();
            initCrypto();
        }).not.toThrow();
    });
});
