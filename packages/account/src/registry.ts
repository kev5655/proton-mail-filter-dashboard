import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError } from '@pms/core/errors';

/**
 * Which accounts this installation has, and where each one keeps its things.
 *
 * `record.ts` says „one account, deliberately", and that stays true of a `Vault`: one object, one
 * key, one mailbox. What changes here is that an installation may have *several* such accounts, and
 * this is the list of them.
 *
 * **The separation is cryptographic, not procedural, and that is the whole design.** Each account
 * has its own directory holding its own `account.json`, its own `mailbox.db`, its own Proton session
 * and its own login-attempt record — and each of those databases is encrypted with a key that only
 * that account's password unwraps. Account B is a directory of noise to anything that has not been
 * given B's password, the running server included.
 *
 * The process holds exactly one key at a time. Getting from A to B means locking A — dropping the
 * key, closing the database, dropping the Proton session — and then unlocking B. There is no moment
 * at which both are open, so there is no route that could read across.
 *
 * Two properties of the file are deliberate:
 *
 *  - **Nothing here is a secret.** A name and a directory. The passwords, the keys and the mail are
 *    all inside the directories, and none of them is readable without the password.
 *  - **No file is ever moved.** An installation that predates this keeps its mailbox exactly where
 *    it is and is written into the index as `.`; anything new goes under `accounts/`. A migration
 *    that relocates an encrypted database is a migration that can lose one.
 */

export interface AccountEntry {
    /** What the person types to unlock it. Its own name, not the Proton address. */
    name: string;
    /** Relative to the data directory. `.` is the installation that predates the index. */
    dir: string;
}

interface RegistryFile {
    accounts: AccountEntry[];
}

const FILE = 'accounts.json';

/** A directory name from an account name, so the layout stays readable and portable. */
export function slugify(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug === '' ? 'konto' : slug;
}

async function read(dataDir: string): Promise<AccountEntry[]> {
    try {
        const raw = await readFile(join(dataDir, FILE), 'utf8');
        const parsed = JSON.parse(raw) as RegistryFile;
        return Array.isArray(parsed.accounts) ? parsed.accounts : [];
    } catch {
        // Absent is the ordinary first state, not a failure.
        return [];
    }
}

async function write(dataDir: string, accounts: AccountEntry[]): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, FILE), `${JSON.stringify({ accounts }, undefined, 4)}\n`, 'utf8');
}

/**
 * The list, with the installation that predates it written in if it is there.
 *
 * `legacyName` is the username from the account file that already sits at the top of the data
 * directory. It is adopted rather than migrated: the entry points at `.`, and not one byte moves.
 */
export async function loadAccounts(dataDir: string, legacyName: string | undefined): Promise<AccountEntry[]> {
    const accounts = await read(dataDir);
    if (accounts.length > 0) {
        return accounts;
    }
    if (legacyName === undefined) {
        return [];
    }
    const adopted = [{ name: legacyName, dir: '.' }];
    await write(dataDir, adopted);
    return adopted;
}

/** Where one account's files live. */
export function directoryOf(dataDir: string, entry: AccountEntry): string {
    return entry.dir === '.' ? dataDir : join(dataDir, entry.dir);
}

/**
 * Find one by name.
 *
 * Case-insensitive, because the name is typed by a person at a lock screen and „Kevin" and „kevin"
 * being different accounts would be a trap rather than a feature.
 */
export function findAccount(accounts: readonly AccountEntry[], name: string): AccountEntry | undefined {
    const wanted = name.trim().toLowerCase();
    return accounts.find((entry) => entry.name.toLowerCase() === wanted);
}

/**
 * Add one, with its own directory.
 *
 * Refuses a name that is already taken rather than pointing two entries at one directory — which
 * would be two accounts sharing a mailbox, the one thing this file exists to prevent.
 */
export async function addAccount(dataDir: string, name: string): Promise<AccountEntry> {
    const trimmed = name.trim();
    if (trimmed === '') {
        throw new AppError('ACCOUNT_MISSING', {
            message: 'Ein Konto braucht einen Namen.',
            hint: 'Der Name wird beim Aufschliessen eingegeben.',
        });
    }

    const accounts = await read(dataDir);
    if (findAccount(accounts, trimmed) !== undefined) {
        throw new AppError('ACCOUNT_EXISTS', {
            message: `Es gibt hier schon ein Konto namens „${trimmed}".`,
            hint: 'Wähle einen anderen Namen, oder schliesse das vorhandene auf.',
        });
    }

    // A suffix rather than a failure when two names slugify alike: the directory is an
    // implementation detail, and a person should not have to think about it.
    const base = slugify(trimmed);
    const taken = new Set(accounts.map((entry) => entry.dir));
    let dir = join('accounts', base);
    for (let index = 2; taken.has(dir); index++) {
        dir = join('accounts', `${base}-${String(index)}`);
    }

    const entry: AccountEntry = { name: trimmed, dir };
    await mkdir(join(dataDir, dir), { recursive: true });
    await write(dataDir, [...accounts, entry]);
    return entry;
}
