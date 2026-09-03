import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import { buildSnapshot } from './snapshot.js';

const log = getLogger('server');

/**
 * The whole API surface of the local server.
 *
 * Read-only, and not by convention: `route` answers `405` to every method that is not `GET` before
 * it looks at the path, so there is no route table entry a write could ever be added to by
 * accident. The server also never holds a Proton client — it reads the local mirror and nothing
 * else — so even a mistake here could not reach the account. `read-only.test.ts` pins both.
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

export function route(method: string | undefined, path: string, db: Db): Reply {
    if (method !== 'GET') {
        return { status: 405, body: { error: READ_ONLY_MESSAGE, code: 'SERVER_READ_ONLY' } };
    }

    switch (path) {
        case '/api/health':
            return { status: 200, body: { ok: true } };

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
