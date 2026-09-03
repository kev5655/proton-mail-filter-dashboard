import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '@pms/core/errors';
import { serveMailbox } from '@pms/server';
import { closeDatabase, openDatabase } from '@pms/store';
import { getMeta } from '@pms/sync';

import { DATA_DIR } from './paths.js';
import { resolvePassphrase } from './session.js';

/**
 * Hand the dashboard the mirrored mailbox.
 *
 * The dividing line the whole design rests on: `pnpm sync` talks to Proton, this does not. It opens
 * the local copy, serves it on the loopback interface and has no Proton client anywhere in reach —
 * so a browser pointed at it cannot cause a request to the account no matter what it asks for.
 *
 * It runs until interrupted, because the dashboard needs it for as long as it is open.
 */

const DATABASE = join(DATA_DIR, 'mailbox.db');

export async function runServe(argv: readonly string[]): Promise<void> {
    const port = Number(value(argv, '--port') ?? process.env['PMS_SERVER_PORT'] ?? 5174);

    console.log('\nProton Mail Sorter — lokaler Server\n');
    console.log('Liest die lokale Kopie. Zu Proton wird keine Verbindung aufgebaut.');

    if (!existsSync(DATABASE)) {
        throw new AppError('SERVER_DATABASE_MISSING', {
            message: 'Es gibt noch keine lokale Kopie des Postfachs.',
            hint: 'Einmal `pnpm sync` laufen lassen — das legt sie an und füllt sie.',
            context: { path: DATABASE },
        });
    }

    const passphrase = await resolvePassphrase();
    const db = await openDatabase({ path: DATABASE, passphrase });

    try {
        const server = await serveMailbox({ db, port: Number.isFinite(port) ? port : 5174 });

        const lastSync = getMeta(db, 'lastSyncAt');
        console.log(
            lastSync === undefined
                ? '\n  Stand: unbekannt — es ist noch keine Synchronisation fertig geworden.'
                : `\n  Stand: ${new Date(Number(lastSync) * 1000).toLocaleString('de-CH')}`
        );
        console.log(`  Server: ${server.url} (nur von diesem Rechner erreichbar)`);
        console.log('\n  Dashboard in einem zweiten Terminal starten: pnpm dev');
        console.log('  Beenden mit Ctrl+C.\n');

        await new Promise<void>((resolve) => {
            const stop = (): void => {
                console.log('\nServer beendet.\n');
                void server.close().then(resolve);
            };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
        });
    } finally {
        closeDatabase(db);
    }
}

function value(argv: readonly string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}
