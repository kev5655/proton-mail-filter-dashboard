/**
 * Typed boundary for `@protontech/crypto/srp`.
 *
 * That package ships raw TypeScript source (its `exports` map points at `.ts` files) written under
 * looser compiler settings than ours, so type-checking it as part of our program produces hundreds
 * of errors that are not ours to fix. Instead we declare exactly the surface we use and let
 * `paths` in tsconfig point at this file; at runtime Node resolves the real module unchanged.
 *
 * The trade-off is deliberate and narrow: we lose compile-time detection of changes to `getSrp`,
 * so `auth.contract.test.ts` asserts its real shape at runtime instead. Keep that test in step with
 * this declaration — it is the only thing standing behind it.
 */
declare module '@protontech/crypto/srp' {
    export interface AuthInfo {
        Version: number;
        Modulus: string;
        ServerEphemeral: string;
        Username: string;
        Salt: string;
    }

    export interface AuthCredentials {
        username: string;
        password: string;
    }

    export interface SrpProofs {
        /** Base64. */
        clientEphemeral: string;
        /** Base64. */
        clientProof: string;
        /** Base64. Must equal the `ServerProof` Proton returns, or the login is aborted. */
        expectedServerProof: string;
        sharedSession: Uint8Array;
    }

    export function getSrp(
        info: AuthInfo,
        credentials: AuthCredentials,
        authVersion?: number
    ): Promise<SrpProofs>;

    export const AUTH_VERSION: number;
}
