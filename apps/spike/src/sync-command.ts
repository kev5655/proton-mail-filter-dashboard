import { join } from 'node:path';

import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { getMeta, readFilters, readFolderTree, syncAll, type StoredFolder } from '@pms/sync';

import { DATA_DIR } from './paths.js';
import { connect } from './session.js';

/**
 * Fill the encrypted local copy from the real account.
 *
 * This is the first thing in the project that keeps anything, and it is deliberately still a
 * command rather than a service: the sync can be watched, interrupted and inspected before anything
 * is built on top of it. Against Proton it is as read-only as the rest of the spike — the only
 * writes are into the local database.
 *
 * It is also where the pacing becomes visible. A page of a hundred messages costs about a second,
 * so a year of mail takes minutes. That is the intended cost and the reason for the progress line.
 */

const DATABASE = join(DATA_DIR, 'mailbox.db');

/** Windows the user can ask for, in days. `undefined` means the whole account. */
const WINDOWS: Record<string, number | undefined> = {
    '30': 30,
    '90': 90,
    '365': 365,
    all: undefined,
};

export interface SyncArgs {
    /** One of the keys of WINDOWS. */
    window: string;
    maxMessages: number;
}

export function parseSyncArgs(argv: readonly string[]): SyncArgs {
    const value = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const days = value('--days') ?? '30';
    const max = Number(value('--max') ?? 2_000);

    return {
        window: days in WINDOWS ? days : '30',
        maxMessages: Number.isFinite(max) && max > 0 ? Math.floor(max) : 2_000,
    };
}

export async function runSync(argv: readonly string[]): Promise<void> {
    const args = parseSyncArgs(argv);
    const days = WINDOWS[args.window];

    console.log('\nProton Mail Sorter — Synchronisation\n');
    console.log('Gelesen wird bei Proton, geschrieben nur lokal. Am Konto ändert sich nichts.');
    console.log(
        days === undefined
            ? `Zeitraum: alles, höchstens ${args.maxMessages} Mails.`
            : `Zeitraum: ${days} Tage, höchstens ${args.maxMessages} Mails.`
    );
    console.log('Zwischen den Anfragen liegt rund eine Sekunde — das dauert und ist so gewollt.\n');

    const { http, passphrase } = await connect();
    const db = await openDatabase({ path: DATABASE, passphrase });

    try {
        const begin = days === undefined ? undefined : Math.floor(Date.now() / 1000) - days * 86_400;

        let lastLine = '';
        const result = await syncAll(db, http, {
            ...(begin === undefined ? {} : { window: { begin } }),
            maxMessages: args.maxMessages,
            onProgress: (progress) => {
                const line =
                    progress.stage === 'messages'
                        ? `  Mails: ${progress.done}${progress.total === undefined ? '' : ` von ${progress.total}`}`
                        : `  ${progress.stage === 'labels' ? 'Ordner und Labels' : 'Filter'}: ${progress.done}`;
                if (line !== lastLine) {
                    console.log(line);
                    lastLine = line;
                }
            },
        });

        console.log('\n✓ Synchronisiert.\n');
        if (result.truncated) {
            console.log(
                `  Hinweis: bei ${args.maxMessages} Mails abgebrochen — die Kopie ist unvollständig.\n` +
                    '  Mit --max höher ansetzen, wenn mehr gebraucht wird.\n'
            );
        }

        summarise(db);
    } finally {
        closeDatabase(db);
    }
}

/**
 * Report from the local copy, not from what was just fetched.
 *
 * Deliberately: reading it back is the only thing that shows the database actually holds what the
 * sync claimed to write. A summary built from the in-memory result would look identical whether or
 * not a single row landed.
 */
function summarise(db: Db): void {
    const folders = readFolderTree(db);
    const filters = readFilters(db);
    const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    const labels = db.prepare('SELECT COUNT(*) AS n FROM labels WHERE type = 1').get() as { n: number };

    console.log('Aus der lokalen Datenbank gelesen:\n');
    console.log(`  Ordner:  ${countTree(folders)} (${folders.length} auf oberster Ebene)`);
    console.log(`  Labels:  ${labels.n}`);
    console.log(
        `  Filter:  ${filters.length} (${filters.filter((entry) => entry.enabled).length} aktiv, ` +
            `${filters.filter((entry) => entry.authoredAs === 'tree').length} in der Proton-UI editierbar)`
    );
    console.log(`  Mails:   ${messages.n}`);

    const lastSync = getMeta(db, 'lastSyncAt');
    if (lastSync !== undefined) {
        console.log(`\n  Stand: ${new Date(Number(lastSync) * 1000).toLocaleString('de-CH')}`);
    }

    console.log(`\n  Datei:   ${DATABASE}`);
    console.log('  Sie ist vollständig verschlüsselt — ohne die Passphrase ist sie nicht lesbar.\n');

    if (folders.length > 0) {
        console.log('Ordnerbaum:\n');
        for (const folder of folders) {
            printFolder(folder);
        }
        console.log('');
    }
}

function countTree(folders: readonly StoredFolder[]): number {
    return folders.reduce((total, folder) => total + 1 + countTree(folder.children), 0);
}

function printFolder(folder: StoredFolder): void {
    console.log(`  ${'  '.repeat(folder.depth)}${folder.depth === 0 ? '' : '└ '}${folder.name}`);
    for (const child of folder.children) {
        printFolder(child);
    }
}
