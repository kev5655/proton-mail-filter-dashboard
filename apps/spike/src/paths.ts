import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where this program keeps its files.
 *
 * Not `process.cwd()`: `pnpm --filter @pms/spike start` runs with the working directory set to
 * `apps/spike`, so anything relative landed there instead of at the repository root. That silently
 * split the state in two — the login guard wrote its cooldown to one path and looked for it at
 * another, which meant the guard did not guard anything.
 *
 * Anchoring to the workspace marker instead makes the location independent of how the program was
 * started.
 */
function findRepoRoot(): string {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth++) {
        if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
            return directory;
        }
        const parent = resolve(directory, '..');
        if (parent === directory) {
            break;
        }
        directory = parent;
    }
    throw new Error('Repository root not found: no pnpm-workspace.yaml above this file.');
}

export const REPO_ROOT = findRepoRoot();

/** Runtime state: the encrypted session and the login cooldown. Git-ignored. */
export const DATA_DIR = join(REPO_ROOT, 'data');

/** Scrubbed API responses, recorded for offline development. Committed. */
export const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'recorded');
