import './polyfill.js';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';

/**
 * Bring Proton's crypto layer up before anything uses it.
 *
 * `CryptoProxy` is a façade with no implementation of its own — in the web client it forwards to a
 * pool of web workers. Nothing wires it up automatically, so calling into it unprepared fails with
 * `CryptoProxy: endpoint not initialized`, several frames deep and nowhere near the real cause.
 *
 * We have no workers and no need for them: this runs in a Node process where the work can happen
 * inline. So we set the direct endpoint instead of the worker pool.
 *
 * The SRP login needs this even though it never touches a mailbox — Proton serves the SRP modulus
 * as a clear-signed PGP message and `getSrp` verifies that signature before using it. That check is
 * what stops a tampered modulus from weakening the handshake, so it is not something to bypass.
 */

let initialised = false;

export function initCrypto(): void {
    if (initialised) {
        return;
    }
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), async (endpoint) => endpoint.clearKeyStore());
    initialised = true;
}

/** Release the endpoint and wipe any key material it still holds. */
export async function releaseCrypto(): Promise<void> {
    if (!initialised) {
        return;
    }
    await CryptoProxy.releaseEndpoint();
    initialised = false;
}
