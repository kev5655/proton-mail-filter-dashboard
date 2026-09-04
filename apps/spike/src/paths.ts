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

/**
 * Load `.env` from the repository root if present.
 *
 * Configuration like the 1Password vault name should not be baked into a repository that is headed
 * for GitHub, and typing it before every command is the kind of friction that ends in someone
 * hardcoding it.
 */
export function loadEnvFile(): { path: string; found: boolean } {
    const envFile = join(REPO_ROOT, '.env');
    const found = existsSync(envFile);
    if (found) {
        process.loadEnvFile(envFile);
    }
    return { path: envFile, found };
}

/** Where the JSON log lines go. Git-ignored, one file per day, never rotated away by us. */
export const LOG_DIR = join(DATA_DIR, 'logs');

/**
 * The log file for today's runs.
 *
 * A file rather than only stderr, because the interesting failures happen while somebody is
 * clicking in the dashboard and the terminal is showing a prompt: by the time a bug is described,
 * the line that explains it has scrolled away or was never on screen at all. One file per day keeps
 * a run findable without a rotation scheme nobody would maintain.
 *
 * `PMS_LOG_FILE` overrides it, and an empty value turns the file off — for anyone who would rather
 * not have their mailbox's shape sitting on disk in yet another place.
 */
export function logFilePath(now = new Date()): string | undefined {
    const override = process.env['PMS_LOG_FILE'];
    if (override !== undefined) {
        return override === '' ? undefined : override;
    }
    const day = now.toISOString().slice(0, 10);
    return join(LOG_DIR, `pms-${day}.log`);
}
