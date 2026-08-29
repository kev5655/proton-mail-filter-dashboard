/**
 * Typed boundary for the parts of `@protontech/crypto` we use beyond `./srp`.
 * Same reason as `protontech-crypto-srp.d.ts`: the package ships raw TypeScript that will not
 * compile under our settings. Backed at runtime by `test/crypto-boundary.test.ts`.
 */
declare module '@protontech/crypto' {
    export interface CryptoEndpoint {
        clearKeyStore(): Promise<void>;
    }

    export const CryptoProxy: {
        setEndpoint<T extends CryptoEndpoint>(endpoint: T, onRelease?: (endpoint: T) => Promise<void>): void;
        releaseEndpoint(): Promise<void>;
    };
}

declare module '@protontech/crypto/proxy/endpoint/api.ts' {
    import type { CryptoEndpoint } from '@protontech/crypto';

    /** The in-process crypto implementation, as opposed to the web-worker pool. */
    export class Api implements CryptoEndpoint {
        static init(options: Record<string, never>): void;
        clearKeyStore(): Promise<void>;
    }
}
