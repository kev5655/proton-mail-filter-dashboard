import { defineConfig } from 'vitest/config';

import base from './vite.config.js';

/**
 * The end-to-end suite, kept apart from `pnpm test`.
 *
 * Separate because these behave differently rather than because they are less important. Each file
 * starts a database, an HTTP server, a dev server and a browser, so they take seconds where the
 * others take milliseconds, and they must not run several at once — two of them racing would fight
 * over ports and over one browser's worth of memory.
 *
 * They are also the only tests that can fail for a reason outside the code: a missing Chromium, a
 * machine under load. Mixing that into the suite everyone runs before committing would teach people
 * to ignore a red result, which is the one thing a test suite cannot survive.
 */
export default defineConfig({
    // Spread rather than merged: `mergeConfig` concatenates arrays, so merging would add the
    // end-to-end files to the ordinary suite instead of replacing it — and `pnpm test:e2e` would
    // quietly run everything.
    ...base,
    test: {
        ...base.test,
        include: ['apps/*/e2e/**/*.e2e.ts'],
        environment: 'node',
        // A browser, a vite server and a database per file.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        // One at a time: they bind ports and each holds a Chromium.
        fileParallelism: false,
        pool: 'forks',
        singleFork: true,
    },
});
