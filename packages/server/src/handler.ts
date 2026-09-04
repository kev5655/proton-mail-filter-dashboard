import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import { buildSnapshot } from './snapshot.js';
import type { AccountChannel } from './account-channel.js';
import type { ApplyChannel } from './apply-channel.js';
import type { SessionChannel } from './session-channel.js';
import type { SyncChannel } from './sync-channel.js';

const log = getLogger('server');

/**
 * The whole API surface of the local server.
 *
 * Nothing here changes anything at Proton, and the shape of the code is what says so rather than a
 * promise in a comment.
 *
 * Five routes are not a `GET`, and each is named in an `if` of its own rather than entered in a
 * table, so adding a sixth is a decision somebody has to write down. Four of them concern Proton:
 * `/api/sync` reads, `/api/apply` records an offer that only a terminal can accept, `/api/login`
 * opens a browser window, `/api/logout` takes the connection away. The fifth, `/api/account`, is
 * the odd one out and cannot reach Proton at all — it opens and closes the local key.
 *
 * The rule this file keeps is that it cannot perform anything. It parses a request and calls a
 * `SyncChannel` handed to it; it holds no Proton client, imports nothing that does, and has no way
 * to reach one. `write-isolation.test.ts` checks that, because a comment stating it would be worth
 * nothing six weeks from now.
 *
 * It listens on the loopback interface only. The database it has open is the user's mailbox in
 * clear text; a process on this machine having it is the premise, the network having it is not.
 */

export interface Reply {
    status: number;
    /** Serialised by the caller, so the routing stays testable without a socket. */
    body: unknown;
}

export const LOCKED_MESSAGE =
    'Dieses Werkzeug ist gesperrt. Ohne Passwort ist die lokale Kopie nicht lesbar.';

export const READ_ONLY_MESSAGE =
    'Dieser Server liest nur. Änderungen an Proton laufen über den bestätigten Weg, nicht über HTTP.';

/** Paths that stream rather than answer once, so the transport handles them before `route`. */
export const STREAM_PATHS = new Set(['/api/sync/stream', '/api/login/stream']);

export interface Channels {
    sync?: SyncChannel | undefined;
    apply?: ApplyChannel | undefined;
    login?: SessionChannel | undefined;
    account?: AccountChannel | undefined;
}

/**
 * `db` is undefined while the tool is locked, and that is the ordinary state at start-up.
 *
 * Nothing can open the mailbox before somebody has handed over the key, so every route that reads
 * it answers `423` — a status that means locked, so the dashboard can tell "not unlocked yet" from
 * "something broke" without parsing a sentence.
 */
export function route(
    method: string | undefined,
    path: string,
    db: Db | undefined,
    channels: Channels = {},
    body?: unknown
): Reply | Promise<Reply> {
    const { sync, apply, login, account } = channels;

    /*
     * Offering a change is not making one.
     *
     * This answers `202` and returns a reference. The change is applied only after a word is typed
     * at the terminal where the server runs — which is why this can answer immediately while
     * nothing has happened yet, and why a request from anything else on this machine gets no
     * further than a question somebody has to read.
     */
    if (method === 'POST' && path === '/api/apply') {
        if (apply === undefined) {
            return {
                status: 503,
                body: { error: 'Dieser Server kann nichts schreiben.', code: 'SERVER_APPLY_UNAVAILABLE' },
            };
        }
        const outcome = apply.offer(body);
        return 'refused' in outcome
            ? { status: 409, body: { error: outcome.refused, code: outcome.code } }
            : {
                  status: 202,
                  body: {
                      requestId: outcome.id,
                      shortDigest: outcome.shortDigest,
                      // So the dashboard can say what will actually happen. Most changes are
                      // confirmed once, in the diff; only the expensive ones are asked about again
                      // in the terminal, and promising that question for every change taught the
                      // reader to disbelieve it.
                      needsTerminal: outcome.needsTerminal,
                      place: outcome.place,
                      reason: outcome.reason,
                      ...(outcome.needsTerminal ? { waiting: 'Bestätigung im Terminal' } : {}),
                  },
              };
    }

    // Reading at Proton, and writing only into the local mirror — which is what makes it the one
    // route that reaches the account and needs no confirmation.
    if (method === 'POST' && path === '/api/sync') {
        if (sync === undefined) {
            return {
                status: 503,
                body: {
                    error: 'Dieser Server kann nicht synchronisieren.',
                    code: 'SERVER_SYNC_UNAVAILABLE',
                },
            };
        }
        // The dashboard may ask for a different auto-sync rhythm while it is at it. Carried on this
        // request rather than on a route of its own: a local timer is not worth a line of the route
        // list, and the list is only worth anything while it is short enough to read.
        const asked = (body as { intervalMinutes?: unknown } | undefined)?.intervalMinutes;
        const refused = sync.start(typeof asked === 'number' ? asked : undefined);
        return refused === undefined
            ? { status: 202, body: { started: true } }
            : { status: 409, body: { error: refused, code: 'SERVER_SYNC_BUSY' } };
    }

    /*
     * Opening a browser window, which is the most consequential thing this tool does.
     *
     * It writes nothing to Proton's data, but it is the most consequential thing this tool does, so
     * it is named here on its own line rather than folded into something that already existed. What
     * it starts is a browser window; what happens in that window is a person's business, and this
     * process never sees a password.
     *
     * `LoginGuard` still decides whether an attempt may happen at all. A button in a web interface
     * makes it easy to hammer a login, which is exactly what earned this account a lockout once.
     */
    if (method === 'POST' && path === '/api/login') {
        if (login === undefined) {
            return {
                status: 503,
                body: {
                    error: 'Dieser Server kann sich nicht anmelden.',
                    code: 'SERVER_LOGIN_UNAVAILABLE',
                },
            };
        }
        const refused = login.start();
        return refused === undefined
            ? { status: 202, body: { started: true } }
            : { status: 409, body: { error: refused, code: 'SERVER_LOGIN_BUSY' } };
    }

    /*
     * The fourth non-GET route, and the only one that only ever takes away.
     *
     * Every other route on this list is guarded because it grants or changes something. This one
     * ends the connection, removes the stored session and deletes the local copy of the mailbox —
     * and a tool that makes connecting easy and disconnecting hard has the wrong shape. That is the
     * whole argument for it being here rather than being a command somebody has to find.
     *
     * `everywhere` additionally asks Proton to revoke the token. It is a separate decision because
     * the answers differ: forgetting locally always works, revoking is one request that can fail.
     */
    if (method === 'POST' && path === '/api/logout') {
        if (login === undefined) {
            return {
                status: 503,
                body: {
                    error: 'Dieser Server verwaltet keine Verbindung.',
                    code: 'SERVER_LOGIN_UNAVAILABLE',
                },
            };
        }
        const everywhere = (body as { everywhere?: unknown } | undefined)?.everywhere === true;
        const refused = login.disconnect(everywhere);
        return refused === undefined
            ? { status: 202, body: { started: true } }
            : { status: 409, body: { error: refused, code: 'SERVER_LOGIN_BUSY' } };
    }

    /*
     * The fifth non-GET route, and the only one that cannot reach Proton.
     *
     * It is also the only one a locked tool answers at all, which is what makes it the gate rather
     * than a feature: registering creates the key the mailbox database and the stored Proton
     * session are encrypted with, and unlocking is what makes every other route on this list able
     * to do anything.
     *
     * One route with a named action rather than eleven paths. The count promise above is about
     * routes that change something at Proton, and this one changes nothing there; spending eleven
     * lines of that promise on a local password form would make the promise harder to read without
     * making it stronger. `AccountChannel` still names each action in a branch of its own.
     */
    if (method === 'POST' && path === '/api/account') {
        if (account === undefined) {
            return {
                status: 503,
                body: {
                    error: 'Dieser Server verwaltet kein Konto.',
                    code: 'SERVER_ACCOUNT_UNAVAILABLE',
                },
            };
        }
        return account.perform(body);
    }

    if (method !== 'GET') {
        return { status: 405, body: { error: READ_ONLY_MESSAGE, code: 'SERVER_READ_ONLY' } };
    }

    switch (path) {
        case '/api/health':
            return { status: 200, body: { ok: true } };

        case '/api/sync':
            return {
                status: 200,
                body: { available: sync?.available ?? false, ...(sync?.state ?? { state: 'idle' }) },
            };

        case '/api/login':
            return {
                status: 200,
                body: {
                    available: login?.available ?? false,
                    signedIn: login?.signedIn ?? false,
                    ...(login?.state ?? { state: 'idle' }),
                },
            };

        case '/api/account':
            return {
                status: 200,
                body:
                    account?.view ?? {
                        available: false,
                        registered: false,
                        unlocked: true,
                        requiresTotp: false,
                        hasPasskeys: false,
                        passkeys: [],
                        graceMinutes: 0,
                        withinGrace: false,
                        // No account surface means no lock: an older server, or one started
                        // without one. The dashboard must not put a lock screen in front of a
                        // mailbox that is being served.
                        ready: true,
                    },
            };

        case '/api/mailbox': {
            if (db === undefined) {
                return { status: 423, body: { error: LOCKED_MESSAGE, code: 'ACCOUNT_LOCKED' } };
            }
            const snapshot = buildSnapshot(db);
            log.debug(
                {
                    folders: snapshot.folders.length,
                    rules: snapshot.rules.length,
                    messages: snapshot.messages.length,
                },
                'served the mailbox snapshot'
            );
            return { status: 200, body: snapshot };
        }

        default: {
            const offered = /^\/api\/apply\/([\w-]+)$/.exec(path);
            if (offered !== null) {
                const state = apply?.stateOf(offered[1] as string);
                return state === undefined
                    ? { status: 404, body: { error: 'Unbekannte Änderung.', code: 'APPLY_UNKNOWN' } }
                    : { status: 200, body: state };
            }
            return { status: 404, body: { error: `Unbekannter Pfad: ${path}`, code: 'SERVER_NO_ROUTE' } };
        }
    }
}
