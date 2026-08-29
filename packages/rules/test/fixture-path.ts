import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate a recorded fixture from the repository root rather than the working directory, which
 * differs depending on whether the tests run from the root or from a single package.
 */
function repoRoot(): string {
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
    throw new Error('Repository root not found.');
}

export function REPO_FIXTURE(name: string): string {
    return join(repoRoot(), 'fixtures', 'recorded', name);
}
