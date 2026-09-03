import { createServer, type Server } from 'node:http';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import { route } from './handler.js';

const log = getLogger('server');

/**
 * Serve the local copy to the dashboard.
 *
 * Loopback only, and that is not a default to be overridden: the database is open in this process,
 * so anything that can reach this port can read the mailbox. There is no authentication because
 * there is no remote — a token would only make it look safe to expose.
 */

export interface ServeOptions {
    db: Db;
    /** 0 asks the operating system for a free one, which is what the tests use. */
    port?: number;
    host?: string;
}

export interface RunningServer {
    port: number;
    url: string;
    close: () => Promise<void>;
}

const DEFAULT_PORT = 5174;
const LOOPBACK = '127.0.0.1';

export async function serveMailbox(options: ServeOptions): Promise<RunningServer> {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? LOOPBACK;

    const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', `http://${host}`).pathname;
        let reply;
        try {
            reply = route(request.method, path, options.db);
        } catch (cause) {
            // One failing request must not take the server with it: the dashboard is meant to stay
            // up while the copy underneath it is being re-synced.
            log.error({ path, cause }, 'request failed');
            reply = {
                status: 500,
                body: {
                    code: 'SERVER_FAILED',
                    error: cause instanceof Error ? cause.message : 'Unbekannter Fehler.',
                },
            };
        }

        response.writeHead(reply.status, {
            'Content-Type': 'application/json; charset=utf-8',
            // The answer is one account's mailbox. Nothing may keep a copy of it.
            'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(reply.body));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', (cause: NodeJS.ErrnoException) => {
            reject(
                cause.code === 'EADDRINUSE'
                    ? new AppError('SERVER_PORT_IN_USE', {
                          message: `Port ${port} ist belegt.`,
                          hint: 'Läuft der Server schon? Sonst mit PMS_SERVER_PORT einen anderen wählen.',
                          context: { port, host },
                          cause,
                      })
                    : cause
            );
        });
        server.listen(port, host, resolve);
    });

    const actual = actualPort(server, port);
    log.info({ port: actual, host }, 'serving the local mailbox copy');

    return {
        port: actual,
        url: `http://${host}:${actual}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
}

function actualPort(server: Server, requested: number): number {
    const address = server.address();
    return address !== null && typeof address === 'object' ? address.port : requested;
}
