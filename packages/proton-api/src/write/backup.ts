import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getLogger } from '@pms/core/logger';

import { getFilters, getFolders, getLabels } from '../read.js';
import type { ProtonHttp } from '../http.js';

/**
 * A full copy of every filter and folder, written before any change.
 *
 * The undo journal is the precise instrument: it reverses one change and moves back exactly the
 * messages that change moved. This is the blunt one underneath it, for the cases the journal cannot
 * cover — a write that half-succeeded, a bug in the inverse, a session where someone lost track.
 *
 * Deliberately dumb: whole state, timestamped filename, no rotation, no cleverness. A backup format
 * that needs interpreting is not a backup.
 */

const log = getLogger('backup');

export interface BackupResult {
    path: string;
    filters: number;
    folders: number;
}

export async function backupBeforeWrite(
    http: ProtonHttp,
    directory: string,
    now: number
): Promise<BackupResult> {
    const [filters, folders, labels] = await Promise.all([
        getFilters(http),
        getFolders(http),
        getLabels(http),
    ]);

    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const path = join(directory, `proton-${stamp}.json`);

    await mkdir(directory, { recursive: true });
    await writeFile(
        path,
        `${JSON.stringify({ takenAt: now, filters, folders, labels }, null, 2)}\n`,
        // Filter names and folder names are personal; the backup is as sensitive as the mailbox.
        { encoding: 'utf8', mode: 0o600 }
    );

    log.info({ path, filters: filters.length, folders: folders.length }, 'backup written');
    return { path, filters: filters.length, folders: folders.length };
}
