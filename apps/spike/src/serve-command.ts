import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyChange, confirmAtTerminal, digestOf, shortDigest, type ChangeRequest } from '@pms/apply';
import { AppError } from '@pms/core/errors';
import { ApplyChannel, serveMailbox, SyncChannel } from '@pms/server';
import { closeDatabase, openDatabase } from '@pms/store';
import { getMeta, syncAll } from '@pms/sync';

import { DATA_DIR } from './paths.js';
import { connect } from './session.js';

/**
 * Hand the dashboard the mirrored mailbox, and let it ask for a fresh one.
 *
 * This process now signs in at start-up and keeps the session, so the dashboard's „jetzt
 * synchronisieren" can do something. That is a deliberate change from the previous arrangement,
 * where the serving process had no way to reach Proton at all, and it is worth being precise about
 * what it does and does not give up.
 *
 * What it gives up: the server can now cause a request to Proton. What it does not: that request is
 * always a read. `syncAll` performs GETs and writes only into the local mirror, the routing code
 * cannot reach a Proton client of its own, and nothing here can change a filter, a folder or a
 * message. Anything that would goes a different way entirely, and `write-isolation.test.ts` is what
 * keeps that true rather than this paragraph.
 *
 * The sign-in happens here, in a terminal, where a password prompt and a second factor make sense.
 * A server that had to authenticate in the middle of an HTTP request could not do either.
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

    // `connect()` rather than `resolvePassphrase()`: the same credentials, but it also establishes
    // the session. It reuses a stored one when it can — a login is the expensive thing here, and
    // starting the dashboard must not become a reason to spend one.
    const { http, passphrase } = await connect();
    const db = await openDatabase({ path: DATABASE, passphrase });

    try {
        const sync = new SyncChannel(async (report) => {
            const result = await syncAll(db, http, {
                window: { begin: Math.floor(Date.now() / 1000) - 365 * 86_400 },
                maxMessages: 20_000,
                onProgress: report,
            });
            return result;
        });

        /*
         * The offer side of writing.
         *
         * `describe` turns a request into what the dashboard is told and what the terminal prints,
         * and it is the only place a malformed offer is rejected — before anybody is asked about
         * it. `run` performs the change, and it does so only after `confirmAtTerminal` returns.
         */
        const confirm = confirmAtTerminal();
        const apply = new ApplyChannel(
            (request) => {
                const parsed = asChangeRequest(request);
                return parsed === undefined
                    ? undefined
                    : {
                          id: parsed.requestId,
                          summary: parsed.change.summary,
                          shortDigest: shortDigest(digestOf(parsed)),
                      };
            },
            async (request) => {
                const parsed = asChangeRequest(request);
                if (parsed === undefined) {
                    throw new AppError('APPLY_NOT_CONFIRMED', {
                        message: 'Die Änderung war nicht lesbar.',
                        hint: 'Es wurde nichts geschrieben.',
                    });
                }
                const outcome = await applyChange(parsed, {
                    http,
                    backupDir: join(DATA_DIR, 'backups'),
                    confirm,
                });
                return {
                    backupPath: outcome.backupPath,
                    ...(outcome.partial === undefined ? {} : { partial: outcome.partial.message }),
                };
            }
        );

        const server = await serveMailbox({
            db,
            port: Number.isFinite(port) ? port : 5174,
            sync,
            apply,
        });

        const lastSync = getMeta(db, 'lastSyncAt');
        console.log(
            lastSync === undefined
                ? '\n  Stand: unbekannt — es ist noch keine Synchronisation fertig geworden.'
                : `\n  Stand: ${new Date(Number(lastSync) * 1000).toLocaleString('de-CH')}`
        );
        console.log(`  Server: ${server.url} (nur von diesem Rechner erreichbar)`);
        console.log('  Synchronisieren lässt sich aus dem Dashboard heraus — gelesen wird, geschrieben nur lokal.');
        console.log('  Änderungen am Konto fragen hier im Terminal nach. Ohne getipptes „ja" passiert nichts.');
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


/**
 * A request from the dashboard, checked before anything is done with it.
 *
 * Shape only. What the change *means* is decided by `applyChange`, which reads the account fresh
 * and refuses a plan computed against a mailbox that has moved since. This is here so a malformed
 * body becomes a refusal rather than a question somebody is asked to answer.
 */
function asChangeRequest(value: unknown): ChangeRequest | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as Partial<ChangeRequest>;
    const wellFormed =
        typeof candidate.requestId === 'string' &&
        candidate.requestId !== '' &&
        typeof candidate.baseVersion === 'string' &&
        typeof candidate.change === 'object' &&
        candidate.change !== null &&
        typeof candidate.change.summary === 'string' &&
        typeof candidate.plan === 'object' &&
        candidate.plan !== null &&
        Array.isArray(candidate.plan.moves) &&
        Array.isArray(candidate.affectedMessageIds);

    return wellFormed ? (candidate as ChangeRequest) : undefined;
}
