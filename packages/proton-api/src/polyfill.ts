/**
 * Must be imported before anything touches `@protontech/crypto/srp`.
 *
 * Proton's crypto library uses `Uint8Array.fromBase64` / `.toBase64`, which Node 24 does not have
 * yet (they arrived in V8 later than this project's minimum runtime). Without them the SRP
 * handshake fails deep inside the library with an error that says nothing about the real cause, so
 * we pull in the polyfill Proton ships for exactly this situation.
 *
 * `packages/proton-api/test/crypto-boundary.test.ts` asserts the helpers are present after this
 * import, so the day Node grows them natively — or Proton drops the polyfill — we find out from a
 * test rather than from a failed login.
 */
import '@protontech/crypto/polyfill';
