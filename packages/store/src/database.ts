import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import Database from 'better-sqlite3-multiple-ciphers';

import { deriveKey, loadOrCreateHeader } from './key.js';
import { MIGRATIONS } from './schema.js';

const log = getLogger('store');

/**
 * The encrypted local database.
 *
 * The whole file is encrypted, not selected columns: subjects and sender addresses are the point of
 * this tool and there is no version of "sensitive fields only" that would leave anything worth
 * protecting outside. Without the key the file is indistinguishable from noise — no SQLite header,
 * no table names, nothing to tell an examiner it is a mailbox at all.
 *
 * SQLCipher is handed a raw key derived by Argon2id (see `key.ts`), so its own weaker KDF is never
 * used.
 */

export type Db = Database.Database;

export interface OpenOptions {
    path: string;
    /** Protects the file on this machine. Not the Proton password — a different thing is at risk. */
    passphrase: string;
}

export async function openDatabase(options: OpenOptions): Promise<Db> {
    await mkdir(dirname(options.path), { recursive: true });

    const header = await loadOrCreateHeader(options.path);
    const key = deriveKey(options.passphrase, header);

    const db: Db = new Database(options.path);
    try {
        // Order matters: the cipher and the key must be set before the first read, or SQLite tries
        // to parse the encrypted header as plaintext and reports a corrupt file.
        db.pragma("cipher='sqlcipher'");
        db.pragma(`key="x'${key}'"`);

        // Forces a read. A wrong key fails here rather than at some later query.
        db.pragma('user_version');
    } catch (cause) {
        db.close();
        throw new AppError('VAULT_KEY_REJECTED', {
            message: 'Die Datenbank liess sich mit dieser Passphrase nicht öffnen.',
            hint:
                'Entweder ist die Passphrase falsch, oder die Datei gehört zu einer anderen. Sie ' +
                'enthält nur eine Kopie dessen, was bei Proton liegt — im Zweifel löschen und neu ' +
                'synchronisieren, das kostet nichts ausser Zeit.',
            context: { path: options.path },
            cause,
        });
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    migrate(db);
    return db;
}

/**
 * Bring the schema up to date.
 *
 * `user_version` is SQLite's own counter and lives inside the encrypted file, so it cannot drift
 * from the data it describes. Each step runs in its own transaction: a failure leaves the database
 * at the last version that fully applied, rather than half-way into one.
 */
export function migrate(db: Db): number {
    const current = Number(db.pragma('user_version', { simple: true }));

    if (current > MIGRATIONS.length) {
        throw new AppError('VAULT_KEY_REJECTED', {
            message: `Die Datenbank hat Schemaversion ${current}, dieses Programm kennt nur ${MIGRATIONS.length}.`,
            hint: 'Sie stammt aus einer neueren Version des Tools. Bitte diese Version aktualisieren.',
            context: { found: current, known: MIGRATIONS.length },
        });
    }

    for (let version = current; version < MIGRATIONS.length; version++) {
        const migration = MIGRATIONS[version];
        /* istanbul ignore next -- the loop bound guarantees it */
        if (migration === undefined) {
            continue;
        }
        db.transaction(() => {
            db.exec(migration.sql);
            db.pragma(`user_version = ${version + 1}`);
        })();
        log.info({ version: version + 1, summary: migration.summary }, 'schema migrated');
    }

    return MIGRATIONS.length;
}

export function closeDatabase(db: Db): void {
    db.close();
}
