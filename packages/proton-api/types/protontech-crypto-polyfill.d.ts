/**
 * Side-effect-only module: installs the base64 helpers `@protontech/crypto/srp` needs.
 * Declared here for the same reason as the srp boundary — the package ships raw TypeScript that
 * will not compile under our settings. See `protontech-crypto-srp.d.ts`.
 */
declare module '@protontech/crypto/polyfill';
