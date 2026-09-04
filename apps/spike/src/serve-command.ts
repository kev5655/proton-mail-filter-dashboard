import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { applyChange, confirmAtTerminal, digestOf, shortDigest, weigh, type ChangeRequest } from '@pms/apply';
import { moveIntoCategory } from '@pms/changes/category';
import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { getMessages } from '@pms/proton-api';
import { ApplyChannel, serveMailbox, SyncChannel } from '@pms/server';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { getMeta, markAdopted, refreshAccountObjects, syncAll } from '@pms/sync';

import { DATA_DIR, logFilePath } from './paths.js';
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

const log = getLogger('serve');

const DATABASE = join(DATA_DIR, 'mailbox.db');

/** How often the copy refreshes itself, in minutes. `--auto-sync 0` turns it off. */
const DEFAULT_AUTO_SYNC_MINUTES = 5;

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
        /*
         * Synchronising from the dashboard, and on a timer.
         *
         * Incremental by default: the first run pulls the year, every run after it asks only for
         * what has arrived since. Messages are upserted, so the copy grows rather than narrowing —
         * and a run that used to take minutes takes a few seconds, which is what makes a timer
         * reasonable at all. Folders and filters are read in full every time regardless; they are
         * three requests and everything else is compared against them.
         */
        /*
         * The timer, restarted by every run rather than ticking on its own schedule.
         *
         * A sync at 4:59 used to be chased by the automatic one at 5:00, which `SyncChannel`
         * refused and this file logged at `debug` — invisible, harmless, and pointless. Restarting
         * on each run means the interval means what it says: this long *since the last sync*.
         *
         * The dashboard may also ask for a different interval, which rides on the sync request
         * because the promise is exactly two non-GET routes and a local timer is not worth the
         * third. It holds for this process only, and the settings screen says so — a value that
         * looks permanent and is gone after Ctrl+C would be worse than an honest sentence.
         */
        let autoSyncMinutes = 0;
        let autoSync: ReturnType<typeof setInterval> | undefined;

        const restartAutoSync = (): void => {
            if (autoSync !== undefined) {
                clearInterval(autoSync);
                autoSync = undefined;
            }
            if (autoSyncMinutes <= 0) {
                return;
            }
            autoSync = setInterval(() => {
                const refused = sync.start();
                if (refused !== undefined) {
                    log.debug({ refused }, 'auto-sync skipped');
                }
            }, autoSyncMinutes * 60_000);
        };

        const sync: SyncChannel = new SyncChannel(
            async (report) => {
                const result = await syncAll(db, http, {
                    window: { begin: Math.floor(Date.now() / 1000) - 365 * 86_400 },
                    maxMessages: 20_000,
                    incremental: true,
                    onProgress: report,
                });
                return result;
            },
            ({ intervalMinutes }) => {
                if (intervalMinutes !== undefined && intervalMinutes !== autoSyncMinutes) {
                    log.info({ from: autoSyncMinutes, to: intervalMinutes }, 'auto-sync interval changed');
                    autoSyncMinutes = intervalMinutes;
                }
                restartAutoSync();
            }
        );

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
                if (parsed === undefined) {
                    return undefined;
                }
                /*
                 * Whether this one will be asked about twice, decided here and told to the
                 * dashboard.
                 *
                 * `weigh` is the authority and lives in `@pms/apply`, which the browser cannot
                 * import — it drags the Proton client along, and `write-isolation.test.ts` exists
                 * to keep that out of the bundle. Reimplementing the thresholds in the interface
                 * would be two answers to one question, and they would drift.
                 *
                 * `applyChange` calls `weigh` again for real; this is the same function on the same
                 * request, so the answer shown is the answer that will be acted on.
                 */
                const weight = weigh(parsed, mailboxSize(db));
                return {
                    id: parsed.requestId,
                    summary: parsed.change.summary,
                    shortDigest: shortDigest(digestOf(parsed)),
                    needsTerminal: weight.needsTerminal,
                    reason: weight.reason,
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
                    // Read fresh: the share of the mailbox a change touches decides whether it is
                    // asked about a second time, and the copy grows with every sync.
                    mailboxSize: mailboxSize(db),
                    /*
                     * The one capability that moves mail, handed in here and nowhere else.
                     *
                     * `@pms/apply` cannot import the message-moving module and neither can the
                     * server that parsed the request — the isolation test checks both. So it is
                     * assembled at the outermost point, in the process that already holds the
                     * session and already owns the terminal the confirmation is typed at. That is
                     * the same shape the guarantee has everywhere else in this file: HTTP can ask,
                     * and only this process can act.
                     */
                    moveToCategory: async (messageIds, categoryId) => {
                        await moveIntoCategory(messageIds, categoryId, {
                            http,
                            readCurrent: async (ids) => {
                                const wanted = new Set(ids);
                                const page = await getMessages(http, { pageSize: 150 });
                                return page.messages
                                    .filter((message) => wanted.has(message.ID))
                                    .map((message) => ({ ID: message.ID, LabelIDs: message.LabelIDs }));
                            },
                        });
                    },
                });
                /*
                 * Bring the copy back in step before answering.
                 *
                 * Not a nicety. The fingerprint the next change is checked against is the one in
                 * this database, and the write just made it wrong — so without this, the second
                 * change of any session was always refused as stale. It also means the dashboard's
                 * reload shows the rule that was just saved instead of the state before it.
                 *
                 * A failure here is reported, never swallowed: the account did change, and a copy
                 * that silently disagrees with it is worse than one that says it is behind.
                 */
                try {
                    await refreshAccountObjects(db, http);
                    // A rule this tool wrote, or one the user just adopted, is not a surprise the
                    // next time the account is read. Marked after the refresh, which rewrites the
                    // table wholesale.
                    markAdopted(db, outcome.adoptedFilterIds);
                } catch (cause) {
                    log.warn({ cause }, 'the change landed but the local copy could not be refreshed');
                }

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

        /*
         * Keeping the copy current without anybody asking.
         *
         * Only worth doing because the sync is incremental: a few requests for whatever arrived in
         * the last five minutes, at the pace `ProtonHttp` imposes anyway. It skips its turn while a
         * sync is already running — `SyncChannel.start` refuses a second one — and it is a timer
         * rather than a promise chain so that Ctrl+C ends it immediately.
         *
         * `--auto-sync 0` turns it off. Some people would rather their mailbox be read when they
         * say so, and that is a reasonable thing to want.
         */
        const requested = Number(value(argv, '--auto-sync') ?? DEFAULT_AUTO_SYNC_MINUTES);
        autoSyncMinutes = Number.isFinite(requested) && requested > 0 ? requested : 0;
        restartAutoSync();


        const lastSync = getMeta(db, 'lastSyncAt');
        console.log(
            lastSync === undefined
                ? '\n  Stand: unbekannt — es ist noch keine Synchronisation fertig geworden.'
                : `\n  Stand: ${new Date(Number(lastSync) * 1000).toLocaleString('de-CH')}`
        );
        console.log(`  Server: ${server.url} (nur von diesem Rechner erreichbar)`);
        console.log('  Synchronisieren lässt sich aus dem Dashboard heraus — gelesen wird, geschrieben nur lokal.');
        console.log(
            '  Grosse Änderungen fragen hier im Terminal nach — alles, was löscht oder einen\n' +
                '  grossen Teil des Postfachs umsortiert. Kleine gelten mit der Bestätigung im Dashboard.'
        );
        console.log(
            autoSync === undefined
                ? '  Automatisch synchronisiert wird nicht (--auto-sync 0).'
                : `  Alle ${String(autoSyncMinutes)} Minuten wird nachgeholt, was seit dem letzten Mal dazugekommen ist.`
        );
        const logFile = logFilePath();
        if (logFile !== undefined) {
            console.log(`  Protokoll: ${logFile}`);
        }
        console.log('\n  Dashboard in einem zweiten Terminal starten: pnpm dev');
        console.log('  Beenden mit Ctrl+C.\n');

        await new Promise<void>((resolve) => {
            const stop = (): void => {
                if (autoSync !== undefined) {
                    clearInterval(autoSync);
                }
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

/** How much mail the copy holds — the denominator `weigh` judges a change's reach against. */
function mailboxSize(db: Db): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
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

    if (!wellFormed) {
        return undefined;
    }

    // A category move is the one kind whose payload is a list of message ids, and those ids are the
    // entire authorisation for moving somebody's mail. Checked here rather than trusted downstream:
    // this is the boundary where a JSON body stops being arbitrary.
    if (candidate.change?.kind === 'move-to-category') {
        const category = candidate.change.category;
        const shaped =
            typeof category === 'object' &&
            category !== null &&
            typeof category.id === 'string' &&
            Array.isArray(category.messageIds) &&
            category.messageIds.every((id: unknown) => typeof id === 'string' && id !== '');
        if (!shaped) {
            return undefined;
        }
    }

    return candidate as ChangeRequest;
}
