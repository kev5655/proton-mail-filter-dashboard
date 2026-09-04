import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getLogger } from '@pms/core/logger';

import { DATA_DIR } from './paths.js';

const log = getLogger('local-data');

/**
 * Removing the local copy of the mailbox, when the connection to Proton is cut.
 *
 * The point is stated by the person who asked for it: after disconnecting, nothing about the
 * mailbox should be left lying on this machine for whoever uses it next. So this is deliberately a
 * *list of files* rather than a directory sweep — a sweep would take things that are not mailbox
 * data and would silently take new things somebody adds later.
 *
 * **The database is four files, not one.** SQLite in WAL mode keeps `-wal` and `-shm` beside it,
 * and a `-wal` left next to a fresh database is a corruption path rather than a leftover. The
 * `.kdf.json` sidecar holds the salt the key is derived from; it is not a secret, but leaving it is
 * pointless once the data it unlocks is gone.
 *
 * **The backups go too, and that is a real loss worth naming.** They contain every filter and
 * folder name — mailbox data by any reading — and they are also the only way to restore a filter
 * somebody deleted. Both facts belong in front of the user before they press the button, and they
 * are in the interface rather than only here.
 *
 * **Two things stay, on purpose.** `login-attempts.json`, because a lockout must not be clearable
 * by disconnecting — that would turn this into a way around `LoginGuard`. And `data/logs/`, which
 * carries error codes and counts and no mail content by construction: `logger-redaction.test.ts` is
 * the proof of that, and throwing away the record of what happened right when something went wrong
 * is the opposite of helpful.
 */
export interface RemovedLocalData {
    /** Paths that existed and are now gone, for the report. */
    removed: string[];
}

export async function deleteLocalCopy(databasePath: string): Promise<RemovedLocalData> {
    const removed: string[] = [];

    const files = [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
        `${databasePath}.kdf.json`,
    ];

    for (const file of files) {
        await rm(file, { force: true });
        removed.push(file);
    }

    // The backups directory itself stays; only what is in it goes. A missing directory would make
    // the next write fail in a way that has nothing to do with this.
    const backups = join(DATA_DIR, 'backups');
    try {
        for (const entry of await readdir(backups)) {
            await rm(join(backups, entry), { recursive: true, force: true });
            removed.push(join(backups, entry));
        }
    } catch {
        // No backups directory yet. Nothing to remove is the outcome we wanted anyway.
    }

    log.info({ count: removed.length }, 'local copy of the mailbox removed');
    return { removed };
}
