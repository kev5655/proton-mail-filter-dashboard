import { defineConfig } from 'vite';

/**
 * Several dependencies ship raw TypeScript rather than compiled JavaScript: Proton's
 * `@protontech/crypto` (whose `exports` map points straight at `.ts` files) and the packages we
 * vendored from their web client. Node cannot load those directly, so they must be transformed
 * rather than treated as external.
 */
export default defineConfig({
    ssr: {
        noExternal: ['@protontech/crypto', '@proton/sieve', '@proton/utils', /^@pms\//],
    },
});
