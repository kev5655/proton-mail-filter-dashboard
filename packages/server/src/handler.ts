import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import { buildSnapshot } from './snapshot.js';
import type { SyncChannel } from './sync-channel.js';

const log = getLogger('server');

/**
 * The whole API surface of the local server.
 *
 * Nothing here changes anything at Proton, and the shape of the code is what says so rather than a
 * promise in a comment.
 *
 * There is exactly one route that is not a `GET`: starting a sync. A sync reads at Proton and
 * writes only into the local mirror, so it needs no confirmation — which is precisely what makes it
 * different from every change to the account, and those do not come through here at all.
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

export const READ_ONLY_MESSAGE =
    'Dieser Server liest nur. Änderungen an Proton laufen über den bestätigten Weg, nicht über HTTP.';

/** Paths that stream rather than answer once, so the transport handles them before `route`. */
export const STREAM_PATHS = new Set(['/api/sync/stream']);

export function route(method: string | undefined, path: string, db: Db, sync?: SyncChannel): Reply {
    // The one exception, named explicitly rather than by a table anyone could extend.
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
        const refused = sync.start();
        return refused === undefined
            ? { status: 202, body: { started: true } }
            : { status: 409, body: { error: refused, code: 'SERVER_SYNC_BUSY' } };
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

        case '/api/mailbox': {
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

        default:
            return { status: 404, body: { error: `Unbekannter Pfad: ${path}`, code: 'SERVER_NO_ROUTE' } };
    }
}
