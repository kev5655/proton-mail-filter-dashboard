import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAppError } from '@pms/core/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addAccount, directoryOf, findAccount, loadAccounts, slugify } from '../src/registry.js';

/**
 * Several accounts on one installation, and the property that makes it defensible.
 *
 * The separation is cryptographic: each account has its own directory with its own `account.json`
 * and its own `mailbox.db`, encrypted with a key only that account's password unwraps. This file
 * holds the list. What is asserted here is that the list can never point two accounts at one
 * directory — because that, and only that, would put two mailboxes behind one key.
 *
 * The other property worth a test is that nothing moves. An installation that predates this keeps
 * its mailbox exactly where it is; a migration that relocates an encrypted database is a migration
 * that can lose one.
 */

let dataDir: string;

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pms-registry-'));
});

afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

describe('an installation that predates the index', () => {
    it('is adopted where it stands, without moving anything', async () => {
        await writeFile(join(dataDir, 'mailbox.db'), 'nicht wirklich eine Datenbank');

        const accounts = await loadAccounts(dataDir, 'kevin');

        expect(accounts).toEqual([{ name: 'kevin', dir: '.' }]);
        expect(directoryOf(dataDir, accounts[0]!)).toBe(dataDir);
        // The point of the exercise: the file is still there, untouched.
        await expect(readFile(join(dataDir, 'mailbox.db'), 'utf8')).resolves.toContain('nicht wirklich');
    });

    it('is written down once, so the name cannot drift afterwards', async () => {
        await loadAccounts(dataDir, 'kevin');
        // A later rename of the account inside its own vault must not silently re-adopt it under
        // the new name and leave two entries.
        const again = await loadAccounts(dataDir, 'jemand-anderes');

        expect(again).toEqual([{ name: 'kevin', dir: '.' }]);
    });
});

describe('a fresh installation', () => {
    it('has no accounts at all, which is a first run and not a failure', async () => {
        expect(await loadAccounts(dataDir, undefined)).toEqual([]);
    });
});

describe('adding one', () => {
    it('gives it a directory of its own', async () => {
        await loadAccounts(dataDir, 'kevin');

        const entry = await addAccount(dataDir, 'Arbeit');

        expect(entry.dir).toBe(join('accounts', 'arbeit'));
        expect(directoryOf(dataDir, entry)).toBe(join(dataDir, 'accounts', 'arbeit'));
        expect(await loadAccounts(dataDir, undefined)).toHaveLength(2);
    });

    it('never points two accounts at one directory', async () => {
        // Two mailboxes behind one key is the one outcome this file exists to prevent, and two
        // different names can slugify alike.
        await addAccount(dataDir, 'Arbeit');
        const second = await addAccount(dataDir, 'ARBEIT!');

        expect(second.dir).not.toBe(join('accounts', 'arbeit'));
        const dirs = (await loadAccounts(dataDir, undefined)).map((entry) => entry.dir);
        expect(new Set(dirs).size).toBe(dirs.length);
    });

    it('refuses a name that is already taken', async () => {
        await addAccount(dataDir, 'Arbeit');

        await expect(addAccount(dataDir, 'arbeit')).rejects.toSatisfy(
            (cause: unknown) => isAppError(cause) && cause.code === 'ACCOUNT_EXISTS'
        );
    });

    it('refuses an empty name, which would have nothing to type at the lock screen', async () => {
        await expect(addAccount(dataDir, '   ')).rejects.toSatisfy(
            (cause: unknown) => isAppError(cause) && cause.code === 'ACCOUNT_MISSING'
        );
    });
});

describe('finding one by what somebody typed', () => {
    it('does not care about case, because a lock screen is not a shell', async () => {
        const accounts = [
            { name: 'Kevin', dir: '.' },
            { name: 'Arbeit', dir: 'accounts/arbeit' },
        ];

        expect(findAccount(accounts, 'kevin')?.dir).toBe('.');
        expect(findAccount(accounts, '  ARBEIT ')?.dir).toBe('accounts/arbeit');
        expect(findAccount(accounts, 'privat')).toBeUndefined();
    });
});

describe('the directory name', () => {
    it('survives the characters a person actually types', async () => {
        expect(slugify('Arbeit')).toBe('arbeit');
        expect(slugify('Kevins Konto')).toBe('kevins-konto');
        expect(slugify('  Ärger & Co.  ')).toBe('arger-co');
    });

    it('never comes out empty, whatever it was given', async () => {
        // A directory named '' would be the data directory itself — every account on top of every
        // other one.
        expect(slugify('???')).toBe('konto');
        expect(slugify('')).toBe('konto');
    });
});

describe('a directory that already exists', () => {
    it('is not clobbered by adding an account beside it', async () => {
        await mkdir(join(dataDir, 'accounts', 'arbeit'), { recursive: true });
        await writeFile(join(dataDir, 'accounts', 'arbeit', 'mailbox.db'), 'vorhanden');

        await addAccount(dataDir, 'Arbeit');

        await expect(readFile(join(dataDir, 'accounts', 'arbeit', 'mailbox.db'), 'utf8')).resolves.toBe(
            'vorhanden'
        );
    });
});
