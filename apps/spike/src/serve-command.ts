import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyChange, confirmAtTerminal, digestOf, shortDigest, weigh, type ChangeRequest } from '@pms/apply';
import { describeChange, type PendingChange } from '@pms/changes';
import { undoChange } from '@pms/changes/undo';
import { moveIntoCategory } from '@pms/changes/category';
import {
    finishPasskeyRegistration,
    newTotpSecret,
    startPasskeyLogin,
    startPasskeyRegistration,
    totpCode,
    totpUri,
    Vault,
} from '@pms/account';
import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { getFolders, getMessages, type ProtonHttp } from '@pms/proton-api';
import {
    AccountChannel,
    ApplyChannel,
    SessionChannel,
    serveMailbox,
    SyncChannel,
    type AccountView,
} from '@pms/server';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import {
    getMeta,
    markAdopted,
    markUndone,
    readJournalEntry,
    readJournalSince,
    recordJournalEntry,
    refreshAccountObjects,
    syncAll,
    type StoredEntry,
} from '@pms/sync';

import { DATA_DIR, logFilePath } from './paths.js';
import { deleteLocalCopy } from './local-data.js';
import { loginInBrowser, resolvePassphrase, resume, signOut } from './session.js';

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
 * **Nothing is open when this starts.** The mailbox database and the stored Proton session are
 * encrypted with a key that only the app password unwraps, so the server comes up serving a lock
 * screen and one route — `/api/account` — and opens the rest when somebody hands the key over. That
 * is the whole point of the account layer: a copy of `data/` without the password is noise.
 *
 * Signing in *at Proton* is a separate act and stays one. Unlocking picks up a stored session if
 * there is one and does nothing at all if there is not; it can never spend a login, which is the
 * expensive thing `LoginGuard` rations and the thing that earned this account a lockout when a
 * program did it on every start.
 *
 * It runs until interrupted, because the dashboard needs it for as long as it is open.
 */

const log = getLogger('serve');

const DATABASE = join(DATA_DIR, 'mailbox.db');
const ACCOUNT_FILE = join(DATA_DIR, 'account.json');

/** How often the copy refreshes itself, in minutes. `--auto-sync 0` turns it off. */
const DEFAULT_AUTO_SYNC_MINUTES = 5;

export async function runServe(argv: readonly string[]): Promise<void> {
    const port = Number(value(argv, '--port') ?? process.env['PMS_SERVER_PORT'] ?? 5174);

    console.log('\nProton Mail Sorter — lokaler Server\n');
    console.log('Liest die lokale Kopie. Zu Proton wird keine Verbindung aufgebaut.');

    const vault = new Vault(ACCOUNT_FILE);
    await vault.load();

    /*
     * The passphrase an installation already has, asked for once and only when it is needed.
     *
     * A database that exists was encrypted with whatever came from 1Password or a prompt. Creating
     * an account would otherwise mint a fresh key and leave every byte of it unreadable — a mailbox
     * lost to a form somebody filled in. So the old passphrase is collected here, at a terminal,
     * and handed to the registration as the key to adopt.
     *
     * Only in this one case. A fresh installation is asked nothing, and an installation that has an
     * account is asked nothing either: from then on the app password is the only key there is.
     */
    let adoptPassphrase: string | undefined;
    if (!vault.state.registered && existsSync(DATABASE)) {
        console.log(
            '\n  Es gibt eine lokale Kopie, aber noch kein Konto für dieses Werkzeug.\n' +
                '  Die bisherige Passphrase wird einmal gebraucht, damit das neue Konto ihren\n' +
                '  Schlüssel übernimmt und die Kopie lesbar bleibt.\n'
        );
        adoptPassphrase = await resolvePassphrase();
    }

    /*
     * Everything that only exists once somebody has unlocked.
     *
     * `undefined` is the honest start-up state, not a placeholder: the key is not in this process
     * yet, so the database cannot be opened and the stored session cannot be decrypted.
     */
    let db: Db | undefined;
    let http: ProtonHttp | undefined;
    /** The dashboard shows the lock screen. Separate from the key being held — see the grace period. */
    let uiLocked = true;
    let openProblem: string | undefined;

    // Declared out here because the `finally` below has to see it: a disconnect closes the database
    // before deleting its files, and closing twice would throw on the way out of a shutdown that
    // already succeeded.
    let databaseClosed = false;

    const requireDb = (): Db => {
        if (db === undefined) {
            throw new AppError('ACCOUNT_LOCKED', {
                message: 'Die lokale Kopie ist nicht geöffnet.',
                hint: 'Im Dashboard anmelden. Ohne Passwort gibt es keinen Schlüssel dafür.',
            });
        }
        return db;
    };

    const requireHttp = (): ProtonHttp => {
        if (http === undefined) {
            throw new AppError('ACCOUNT_LOCKED', {
                message: 'Es besteht keine Verbindung zu Proton.',
                hint: 'Erst im Dashboard anmelden, dann bei Proton verbinden.',
            });
        }
        return http;
    };

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
        /*
         * Set the moment a disconnect begins, and checked by everything that would otherwise keep
         * using the account.
         *
         * Without it the sharp edge is invisible: the tokens live in `ProtonHttp`'s memory, so a
         * timer or a queued request would carry on working against a mailbox somebody has just
         * disconnected from. Refusing with a sentence beats failing with an auth error nobody can
         * place.
         */
        let signedOut = false;

        const refuseWhenSignedOut = (): void => {
            if (!signedOut) {
                return;
            }
            throw new AppError('SESSION_DISCONNECTED', {
                message: 'Die Verbindung zu Proton wurde getrennt.',
                hint: 'Dieser Server beendet sich gleich. Danach über das Dashboard neu verbinden.',
            });
        };

        const restartAutoSync = (): void => {
            if (autoSync !== undefined) {
                clearInterval(autoSync);
                autoSync = undefined;
            }
            if (autoSyncMinutes <= 0) {
                sync.nextRunAt = undefined;
                return;
            }
            autoSync = setInterval(() => {
                const refused = sync.start();
                if (refused !== undefined) {
                    log.debug({ refused }, 'auto-sync skipped');
                }
            }, autoSyncMinutes * 60_000);
            // Told rather than left to be guessed at: the dashboard's own arithmetic — last sync
            // plus the interval in its settings — is wrong on both counts, because the setting
            // only reaches this process on the next manual sync and this timer restarts on every
            // run.
            sync.nextRunAt = Math.floor(Date.now() / 1000) + autoSyncMinutes * 60;
        };

        const sync: SyncChannel = new SyncChannel(
            async (report) => {
                refuseWhenSignedOut();
                const result = await syncAll(requireDb(), requireHttp(), {
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
        /*
         * Taking one recorded change back — the piece both undo and rewind are made of.
         *
         * It lives here because undo needs three things from three places that must not be brought
         * together anywhere else: the journal (this database), the write path (`@pms/apply`, which
         * cannot read a database), and the message-moving module (`@pms/changes/undo`, which
         * nothing else may import). This function is where they meet, once.
         *
         * `undoChange` keeps its own order — rule first, then mail, because the filter is still
         * running and mail moved back under a live rule is re-filed within the hour — and its own
         * refusals: a message somebody has moved by hand since is skipped and named rather than
         * overruled, and one with no recorded previous folder is reported as unrestorable instead
         * of guessed at.
         */
        const undoOne = async (
            entry: StoredEntry,
            performInverse: (inverse: PendingChange) => Promise<void>
        ): Promise<{ restored: number; skipped: number; unrestorable: number }> => {
            if (entry.undoneAtSeconds !== undefined) {
                throw new AppError('UNDO_ENTRY_ALREADY_UNDONE', {
                    message: 'Diese Änderung wurde bereits zurückgenommen.',
                    hint: 'Ein zweites Zurücknehmen wäre etwas anderes als das erste.',
                    context: { entryId: entry.id },
                });
            }

            const live = requireHttp();
            const folders = await getFolders(live);
            const outcome = await undoChange(entry, {
                http: live,
                applyInverse: async () => {
                    await performInverse(entry.inverse);
                },
                readCurrent: async (ids) => {
                    const wanted = new Set(ids);
                    const page = await getMessages(live, { pageSize: 150 });
                    return page.messages
                        .filter((message) => wanted.has(message.ID))
                        .map((message) => ({ ID: message.ID, LabelIDs: message.LabelIDs }));
                },
                folderIds: new Map(folders.map((folder) => [folder.Name, folder.ID])),
            });

            markUndone(requireDb(), entry.id, Math.floor(Date.now() / 1000));

            return {
                restored: outcome.restored.reduce((total, group) => total + group.messageIds.length, 0),
                skipped: outcome.skippedMovedSince.length,
                unrestorable: outcome.unrestorable.length,
            };
        };

        /*
         * Deletions are confirmed in the dashboard, against the app password.
         *
         * A promise per pending change, resolved by `confirm-change` on the account surface once
         * the `Vault` has accepted the password. The reasoning for moving this off the terminal is
         * in `weigh()`; what happens here is only the plumbing, and two properties of it matter.
         *
         * It expires. A grant that waited forever would leave a change armed for as long as the
         * server runs, which is exactly the shape of an offer nobody remembers making.
         *
         * And it is keyed by the request id, so the password answers *that* change and no other.
         * A blanket „the user typed their password recently" would confirm whatever arrived next.
         */
        const pendingGrants = new Map<string, (verdict: 'granted' | 'declined' | 'expired') => void>();
        const GRANT_TIMEOUT_MS = 5 * 60_000;

        const confirmInDashboard = (offer: { request: { requestId: string } }): Promise<'granted' | 'declined' | 'expired'> =>
            new Promise((resolve) => {
                const id = offer.request.requestId;
                const timer = setTimeout(() => {
                    pendingGrants.delete(id);
                    resolve('expired');
                }, GRANT_TIMEOUT_MS);
                pendingGrants.set(id, (verdict) => {
                    clearTimeout(timer);
                    pendingGrants.delete(id);
                    resolve(verdict);
                });
            });

        const atTerminal = confirmAtTerminal();

        /*
         * Where the second question is asked, decided by `weigh` and routed here.
         *
         * The terminal is kept for everything that moves mail, and it is also the fallback when
         * there is no account: an installation with no password to ask for has nothing to check a
         * dashboard answer against, and then the keystroke is all there is.
         */
        const confirm: typeof atTerminal = async (offer) =>
            offer.place === 'password' && vault.state.registered
                ? confirmInDashboard(offer)
                : atTerminal(offer);

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
                const weight = weigh(parsed, mailboxSize(requireDb()));
                return {
                    id: parsed.requestId,
                    summary: describeChange(parsed.change),
                    shortDigest: shortDigest(digestOf(parsed)),
                    needsTerminal: weight.needsTerminal,
                    place: weight.place,
                    reason: weight.reason,
                };
            },
            async (request) => {
                refuseWhenSignedOut();
                const parsed = asChangeRequest(request);
                if (parsed === undefined) {
                    throw new AppError('APPLY_NOT_CONFIRMED', {
                        message: 'Die Änderung war nicht lesbar.',
                        hint: 'Es wurde nichts geschrieben.',
                    });
                }
                const outcome = await applyChange(parsed, {
                    http: requireHttp(),
                    backupDir: join(DATA_DIR, 'backups'),
                    confirm,
                    // Read fresh: the share of the mailbox a change touches decides whether it is
                    // asked about a second time, and the copy grows with every sync.
                    mailboxSize: mailboxSize(requireDb()),
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
                    /*
                     * Taking a recorded change back.
                     *
                     * Assembled here because undo needs three things that live in three different
                     * places and must not be brought together anywhere else: the journal (this
                     * database), the write path (`@pms/apply`, which cannot read a database), and
                     * the message-moving module (`@pms/changes/undo`, which nothing else may
                     * import). This function is where they meet, once.
                     *
                     * `undoChange` keeps its own order — rule first, then mail — and its own
                     * refusals: a message somebody has moved by hand since is skipped and named
                     * rather than overruled, and one with no recorded previous folder is reported
                     * as unrestorable instead of guessed at.
                     */
                    undoEntry: async (entryId, performInverse) => {
                        const entry = readJournalEntry(requireDb(), entryId);
                        if (entry === undefined) {
                            throw new AppError('APPLY_MALFORMED', {
                                message: 'Diesen Eintrag gibt es im Verlauf nicht.',
                                hint: 'Es wurde nichts geschrieben.',
                                context: { entryId },
                            });
                        }
                        return undoOne(entry, performInverse);
                    },
                    /*
                     * The same act, several times, newest first.
                     *
                     * Each step is journalled as it lands, so a rewind that stops halfway leaves a
                     * record somebody can read rather than an account nobody can account for. It
                     * stops at the first failure and says where — and nothing rolls forward again,
                     * because that would be a second unwatched write series inside an error path.
                     */
                    rewindTo: async (entryId, performInverse) => {
                        const chain = readJournalSince(requireDb(), entryId);
                        if (chain.length === 0) {
                            throw new AppError('APPLY_MALFORMED', {
                                message: 'Ab diesem Eintrag gibt es nichts zurückzunehmen.',
                                hint: 'Es wurde nichts geschrieben.',
                                context: { entryId },
                            });
                        }

                        const steps: Array<{ entryId: string; restored: number }> = [];
                        for (const entry of chain) {
                            try {
                                const result = await undoOne(entry, performInverse);
                                steps.push({ entryId: entry.id, restored: result.restored });
                            } catch (cause) {
                                log.warn({ entryId: entry.id, cause }, 'rewind stopped');
                                return { steps, stoppedAt: entry.id };
                            }
                        }
                        return { steps };
                    },
                    moveToCategory: async (messageIds, categoryId) => {
                        const live = requireHttp();
                        await moveIntoCategory(messageIds, categoryId, {
                            http: live,
                            readCurrent: async (ids) => {
                                const wanted = new Set(ids);
                                const page = await getMessages(live, { pageSize: 150 });
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
                    await refreshAccountObjects(requireDb(), requireHttp());
                    // A rule this tool wrote, or one the user just adopted, is not a surprise the
                    // next time the account is read. Marked after the refresh, which rewrites the
                    // table wholesale.
                    markAdopted(requireDb(), outcome.adoptedFilterIds);
                } catch (cause) {
                    log.warn({ cause }, 'the change landed but the local copy could not be refreshed');
                }

                /*
                 * The record of what was done, kept.
                 *
                 * `applyChange` builds this from what verification *observed* — never from what the
                 * plan intended — and until now this function dropped it. That is why „Verlauf" was
                 * empty against every real account and why `undoChange` had no caller: the entry
                 * that undo works from was computed correctly and then discarded, every time.
                 *
                 * Recorded after the refresh, and never allowed to fail the change. The write
                 * already succeeded; losing the journal line is bad, and throwing over the top of a
                 * successful write would be worse — the backup on disk can still rebuild the rest.
                 */
                try {
                    recordJournalEntry(requireDb(), {
                        ...outcome.entry,
                        backupPath: outcome.backupPath,
                        // An undo gets its own line in the record, naming what it took back. That
                        // is what keeps a half-finished rewind explicable afterwards — and what
                        // stops a rewind walking back over its own steps.
                        ...(parsed.change.kind === 'undo-entry' && parsed.change.undo !== undefined
                            ? { undoesId: parsed.change.undo.entryId }
                            : {}),
                    });
                } catch (cause) {
                    log.warn({ cause }, 'the change landed but could not be journalled');
                }

                return {
                    backupPath: outcome.backupPath,
                    ...(outcome.partial === undefined ? {} : { partial: outcome.partial.message }),
                };
            }
        );

        /*
         * Signing in from the dashboard, without a password passing through this process.
         *
         * It opens Proton's own login page in a real browser profile and waits. The person types,
         * or their password manager's extension fills the form the way it would on any other site,
         * or they touch a passkey — and none of that is visible from here. That is what makes it
         * defensible: we are not participating in the login, we are opening a window.
         *
         * A profile is required and asked for rather than defaulted. An extension cannot exist in a
         * throwaway profile, and silently making one would produce a window with no password
         * manager in it and no explanation.
         */
        const login: SessionChannel = new SessionChannel(
            async (report: (phase: 'opening' | 'waiting') => void) => {
            const profileDir = process.env['PMS_BROWSER_PROFILE'];
            if (profileDir === undefined || profileDir === '') {
                throw new AppError('BROWSER_LOGIN_NOT_CONFIGURED', {
                    message: 'Für die Anmeldung im Browser fehlt ein Profil.',
                    hint:
                        'PMS_BROWSER_PROFILE setzen — dorthin gehört das Chrome-Profil, in dem deine ' +
                        '1Password-Erweiterung installiert ist. Ohne Profil gibt es kein Fenster mit ' +
                        'Passwort-Manager darin.',
                });
            }
            await loginInBrowser({
                passphrase: vault.passphrase(),
                profileDir,
                // So the session lands in the client this process is already using. Storing it and
                // not handing it over would make a sign-in take effect at the *next* start.
                ...(http === undefined ? {} : { http }),
                ...(process.env['PMS_BROWSER_CHANNEL'] === undefined
                    ? {}
                    : { channel: process.env['PMS_BROWSER_CHANNEL'] as 'chrome' | 'msedge' | 'chromium' }),
                onOpen: () => {
                    report('waiting');
                },
            });
            },
            /*
             * Cutting the connection, in the order that makes it real.
             *
             * `signOut` stops the timer, revokes while the tokens still exist, clears the client
             * and only then removes the file — the reasoning for each step is there. What is added
             * here is the part Kevin asked for: the local copy goes too, so nothing about the
             * mailbox is left on this machine for whoever uses it next.
             *
             * The database has to be *closed* before its files are removed, and once it is closed
             * this process has nothing left to serve. So it shuts down rather than staying up in a
             * state where every request fails for a reason the screen cannot explain.
             */
            async (everywhere) => {
                signedOut = true;
                const result = await signOut({
                    http: requireHttp(),
                    everywhere,
                    stopBackgroundWork: () => {
                        if (autoSync !== undefined) {
                            clearInterval(autoSync);
                            autoSync = undefined;
                        }
                    },
                });

                if (db !== undefined) {
                    closeDatabase(db);
                    db = undefined;
                }
                await deleteLocalCopy(DATABASE);
                databaseClosed = true;

                // Long enough for the dashboard to read the final state off the stream. Ending the
                // process in the same tick would close the stream first and leave the screen
                // showing „wird getrennt" forever.
                setTimeout(() => {
                    console.log('\n  Verbindung getrennt, lokale Kopie gelöscht. Server beendet.\n');
                    void server.close().then(() => {
                        process.exit(0);
                    });
                }, 1_500);

                return result;
            },
            // Not known yet. Whether a stored session exists is only readable once the key that
            // decrypts it has been handed over, so `openLocalData` sets it.
            false,
            // Straight into a sync once a login has succeeded. Incremental, like every other run:
            // it asks for what has arrived since the last one, which is seconds unless this is the
            // first connection on this machine. A refusal is logged and nothing more — the usual
            // one is „es läuft bereits eine Synchronisation", which needs no reaction.
            () => {
                const refused = sync.start();
                if (refused !== undefined) {
                    log.debug({ refused }, 'sync after login skipped');
                }
            }
        );

        /*
         * Opening what the key opens, once there is a key.
         *
         * Two things, in this order and no other: the mailbox database, then whatever Proton
         * session is stored beside it. Both are encrypted with the same passphrase, and until this
         * moment neither could be read at all.
         *
         * `resume` is deliberately not `connect`. It picks up a stored session and refreshes it if
         * it needs it, and if there is none it comes back with a client that has none — it can
         * never start a login. Unlocking a dashboard must not be able to spend the expensive thing.
         */
        const openLocalData = async (): Promise<void> => {
            if (db !== undefined) {
                return;
            }
            openProblem = undefined;
            const passphrase = vault.passphrase();
            try {
                db = await openDatabase({ path: DATABASE, passphrase });
                const resumed = await resume(passphrase);
                http = resumed.http;
                login.signedIn = resumed.signedIn;
                restartAutoSync();
                const lastSync = getMeta(db, 'lastSyncAt');
                console.log(
                    lastSync === undefined
                        ? '\n  Aufgeschlossen. Stand: unbekannt — es ist noch keine Synchronisation fertig geworden.'
                        : `\n  Aufgeschlossen. Stand: ${new Date(Number(lastSync) * 1000).toLocaleString('de-CH')}`
                );
                console.log(
                    resumed.signedIn
                        ? '  Gespeicherte Proton-Sitzung übernommen.\n'
                        : '  Keine gültige Proton-Sitzung — im Dashboard verbinden.\n'
                );
            } catch (cause) {
                // Reported rather than thrown past the HTTP layer: the unlock itself succeeded, and
                // a lock screen that disappears onto an empty mailbox explains nothing.
                openProblem = cause instanceof Error ? cause.message : 'Unbekannter Fehler.';
                log.error({ cause }, 'unlocked, but the local data could not be opened');
                throw cause;
            }
        };

        const closeLocalData = (): void => {
            if (db !== undefined) {
                closeDatabase(db);
                db = undefined;
            }
            http = undefined;
            login.signedIn = false;
            if (autoSync !== undefined) {
                clearInterval(autoSync);
                autoSync = undefined;
            }
        };

        const view = (): AccountView => {
            const state = vault.state;
            return {
                available: true,
                registered: state.registered,
                unlocked: state.unlocked && !uiLocked,
                ...(state.username === undefined ? {} : { username: state.username }),
                requiresTotp: state.requiresTotp,
                hasPasskeys: state.passkeys.length > 0,
                passkeys: state.passkeys,
                ...(state.graceUntil === undefined ? {} : { graceUntil: state.graceUntil }),
                graceMinutes: state.graceMinutes,
                withinGrace: uiLocked && vault.withinGrace,
                ready: db !== undefined && !uiLocked,
                ...(openProblem === undefined ? {} : { problem: openProblem }),
            };
        };

        /*
         * The account surface, assembled here because this is the only place that may hold the key.
         *
         * `packages/server/` parses these requests and can perform none of them — it has no `Vault`,
         * no database and no way to obtain either. That is the same shape as every other capability
         * in this file: HTTP can ask, and only this process can act.
         */
        const account = new AccountChannel({
            view,
            register: async (input) => {
                await vault.register({
                    ...input,
                    // The key an existing installation already uses, collected at the terminal
                    // above. Without it, registering would orphan the mailbox.
                    ...(adoptPassphrase === undefined ? {} : { adoptPassphrase }),
                });
                adoptPassphrase = undefined;
                uiLocked = false;
                await openLocalData();
            },
            unlock: async (input) => {
                await vault.unlock(input);
                uiLocked = false;
                await openLocalData();
            },
            confirmChange: async (requestId, password) => {
                const waiting = pendingGrants.get(requestId);
                if (waiting === undefined) {
                    throw new AppError('APPLY_CONFIRMATION_EXPIRED', {
                        message: 'Zu dieser Bestätigung wartet keine Änderung.',
                        hint: 'Sie ist abgelaufen oder wurde schon beantwortet. Es wurde nichts geschrieben.',
                        context: { requestId },
                    });
                }
                // The password first, and only then the grant. Verifying afterwards would mean a
                // wrong password had already released the change.
                vault.verifyPassword(password);
                waiting('granted');
            },
            resume: async () => {
                if (!vault.withinGrace) {
                    throw new AppError('ACCOUNT_LOCKED', {
                        message: 'Der Schlüssel wird nicht mehr gehalten.',
                        hint: 'Die Nachfrist ist abgelaufen. Es braucht wieder das Passwort.',
                    });
                }
                uiLocked = false;
                await openLocalData();
            },
            /*
             * Locking, and what it does to the data underneath.
             *
             * Within the grace period the key is still held, so the database stays open and the
             * Proton session stays live — that is the convenience the grace period *is*, and
             * pretending otherwise by closing the file while the key sits in memory would be
             * theatre. Once the key is genuinely gone, so is everything it opened.
             */
            lock: (immediate) => {
                uiLocked = true;
                vault.lock(immediate);
                if (!vault.state.unlocked) {
                    closeLocalData();
                }
            },
            changePassword: async (current, next) => {
                await vault.changePassword(current, next);
            },
            beginTotp: async () => {
                const secret = newTotpSecret();
                return {
                    secret,
                    uri: totpUri(secret, vault.state.username ?? 'proton-mail-sorter'),
                };
            },
            enableTotp: async (secret, code) => {
                // Confirmed against the secret the user is about to be locked behind, before it is
                // stored. An enrolment that stored first would lock somebody out of their own data
                // because they mistyped a digit into an authenticator app.
                if (code !== totpCode(secret, Math.floor(Date.now() / 1000))) {
                    throw new AppError('ACCOUNT_SECOND_FACTOR_WRONG', {
                        message: 'Der Code stimmt nicht.',
                        hint: 'Es wurde nichts eingeschaltet. Der Code gilt dreissig Sekunden.',
                    });
                }
                await vault.enableTotp(secret);
            },
            disableTotp: async (password) => {
                // The password again, because switching a second factor off is exactly the act
                // somebody who found an unlocked screen would perform.
                await vault.changePassword(password, password);
                await vault.disableTotp();
            },
            beginPasskeyRegistration: async (origin) =>
                startPasskeyRegistration(vault.state.username ?? 'proton-mail-sorter', vault.passkeys, origin),
            finishPasskeyRegistration: async (input) => {
                await vault.addPasskey(
                    await finishPasskeyRegistration(input.response, input.challenge, input.origin, input.label)
                );
            },
            removePasskey: async (id) => {
                await vault.removePasskey(id);
            },
            beginPasskeyLogin: async (origin) => startPasskeyLogin(vault.passkeys, origin),
            setGraceMinutes: async (minutes) => {
                await vault.setGraceMinutes(minutes);
            },
        });

        /*
         * The dashboard's own files, when this is a packaged copy.
         *
         * In development vite serves them and proxies `/api` here; a downloaded copy has no vite,
         * so this process does both. Same origin either way, which is what keeps the browser from
         * ever having to be told which origins may read one account's mailbox.
         */
        const webRoot = packagedWebRoot();

        const server = await serveMailbox({
            // A function, because the mailbox appears when somebody unlocks and disappears when
            // they lock — the server outlives both.
            db: () => db,
            port: Number.isFinite(port) ? port : 5174,
            sync,
            apply,
            login,
            account,
            ...(webRoot === undefined ? {} : { webRoot }),
            ...(process.env['PMS_OLLAMA_URL'] === undefined
                ? {}
                : { ollamaUrl: process.env['PMS_OLLAMA_URL'] }),
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


        console.log(
            vault.state.registered
                ? '\n  Gesperrt. Die lokale Kopie wird erst nach der Anmeldung im Dashboard geöffnet.'
                : '\n  Noch kein Konto. Im Dashboard eines anlegen — damit entsteht der Schlüssel für die lokalen Daten.'
        );
        console.log(
            webRoot === undefined
                ? `  Server: ${server.url} (nur von diesem Rechner erreichbar)`
                : `  Dashboard: ${server.url} (nur von diesem Rechner erreichbar)`
        );
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
        if (webRoot === undefined) {
            console.log('\n  Dashboard in einem zweiten Terminal starten: pnpm dev');
        } else {
            console.log(`\n  Im Browser öffnen: ${server.url}`);
        }
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
        // A disconnect closes it before deleting its files; closing twice would throw on the way
        // out of a shutdown that already succeeded.
        if (!databaseClosed && db !== undefined) {
            closeDatabase(db);
        }
    }
}

/**
 * The built dashboard beside this file, or nothing.
 *
 * A packaged copy lays the pages out next to the bundle; a checkout has no such directory and gets
 * `undefined`, which leaves vite serving them exactly as before. `PMS_WEB_ROOT` overrides both, so
 * the packaged layout can be tried from a checkout without building one.
 */
function packagedWebRoot(): string | undefined {
    const configured = process.env['PMS_WEB_ROOT'];
    if (configured !== undefined && configured !== '') {
        return existsSync(configured) ? configured : undefined;
    }
    const beside = fileURLToPath(new URL('./web/', import.meta.url));
    return existsSync(join(beside, 'index.html')) ? beside : undefined;
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
        typeof candidate.change.kind === 'string' &&
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
