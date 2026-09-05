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
 * Three answers, in this order, and the middle one is the reason this is not two lines:
 *
 *  1. **`PMS_DATA_DIR`**, when somebody has said where.
 *  2. **The repository root**, found by walking up to `pnpm-workspace.yaml`. This is a checkout,
 *     and `data/` belongs beside the code it goes with.
 *  3. **Beside the program**, when there is no workspace above it — which is every downloaded copy.
 *     It used to *throw* there, so a packaged build failed on its first line; and the alternative,
 *     a hidden directory somewhere under the home directory, would hide the one thing this tool
 *     promises you can delete: the mailbox it keeps on your machine.
 */
function findBase(): string {
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
    // A packaged copy: `app/server.mjs`, so its files go one level up, beside the launcher where
    // somebody can see them.
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The directory everything else is relative to.
 *
 * Named `REPO_ROOT` because in a checkout that is what it is, and because a rename would touch
 * every caller for no gain. In a downloaded copy it is the directory the launcher sits in.
 */
export const REPO_ROOT = findBase();

/** Runtime state: the encrypted session and the login cooldown. Git-ignored. */
export const DATA_DIR = process.env['PMS_DATA_DIR'] ?? join(REPO_ROOT, 'data');

export const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'recorded');

/**
 * The account this process currently holds, as a directory.
 *
 * Mutable, and that is what the process is: it holds exactly one account's key at a time, and this
 * says which one. Everything that belongs to an account — its mailbox, its Proton session, its
 * login-attempt record, its backups — hangs off this, so switching accounts cannot leave one of
 * them pointing at the previous one. A session file shared between two accounts would mean
 * account B reaching Proton as account A, which is the exact failure the separation exists against.
 *
 * It starts at the data directory itself, which is where an installation that predates the account
 * index keeps its files. Nothing is ever moved there; see `registry.ts`.
 *
 * Set only after a password has been accepted, so a failed unlock cannot repoint it.
 */
let currentAccountDir = DATA_DIR;

export function accountDir(): string {
    return currentAccountDir;
}

export function useAccountDir(directory: string): void {
    currentAccountDir = directory;
}

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
