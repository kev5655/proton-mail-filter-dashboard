import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { defineConfig } from 'vite';

/**
 * One config for both running and testing — a second one drifts, and the drift shows up as a
 * dependency that resolves in tests but not at runtime, or the reverse.
 */

/**
 * Dependencies that ship raw TypeScript rather than compiled JavaScript, and so must be
 * transformed rather than treated as external: Proton's `@protontech/crypto`, whose `exports` map
 * points straight at `.ts` files, and the packages vendored from their web client.
 */
const protonSources = ['@protontech/crypto', '@proton/sieve', '@proton/utils', /^@pms\//];

/**
 * `openpgp/lightweight` is a browser-only entry point of `@protontech/openpgp`: its exports map
 * declares a `browser` condition and nothing else, so under Node the specifier resolves to nothing.
 * Proton's crypto package imports it unconditionally, which makes their whole crypto layer — and
 * therefore the SRP login — unusable outside a browser without this redirect.
 *
 * Pointed at a resolved absolute path rather than the package name, because a bare specifier here
 * is resolved relative to the importer, deep inside another package's pnpm directory.
 */
const require_ = createRequire(import.meta.url);
const openpgpNodeEntry = join(
    dirname(require_.resolve('@protontech/openpgp')),
    'openpgp.mjs' // the ESM sibling of the resolved .min.cjs
);

export default defineConfig({
    // Lets .tsx compile anywhere in the workspace without the React plugin, which the web app's
    // own config carries. Needed so the page render tests can run in the Node environment.
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    resolve: {
        alias: [{ find: /^openpgp\/lightweight$/, replacement: openpgpNodeEntry }],
    },
    ssr: {
        noExternal: protonSources,
    },
    test: {
        include: ['packages/*/test/**/*.test.{ts,tsx}', 'apps/*/test/**/*.test.{ts,tsx}'],
        environment: 'node',
        server: {
            deps: { inline: protonSources },
        },
    },
});
