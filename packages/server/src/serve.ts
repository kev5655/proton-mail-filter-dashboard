import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import { route, STREAM_PATHS } from './handler.js';
import type { SyncChannel } from './sync-channel.js';

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
    /** Absent when this server has no way to reach Proton — then no sync can be started. */
    sync?: SyncChannel | undefined;
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

        if (STREAM_PATHS.has(path)) {
            streamSyncState(request, response, options.sync);
            return;
        }

        let reply;
        try {
            reply = route(request.method, path, options.db, options.sync);
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

/**
 * The sync's progress, as server-sent events.
 *
 * A stream rather than polling because the interesting part is the shape of the wait: a page of a
 * hundred messages costs about a second by design, so a long sync is minutes of steady movement,
 * and a progress bar that only updates when someone asks is a progress bar that looks stuck.
 *
 * The current state is sent immediately on connect. A dashboard reloaded mid-sync then shows the
 * run already in flight rather than an idle bar next to a busy server.
 */
function streamSyncState(request: IncomingMessage, response: ServerResponse, sync: SyncChannel | undefined): void {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Vite's dev proxy buffers by default; without this the events arrive in one lump at the end.
        'X-Accel-Buffering': 'no',
    });

    const send = (state: unknown): void => {
        response.write(`data: ${JSON.stringify(state)}\n\n`);
    };

    if (sync === undefined) {
        send({ state: 'idle', available: false });
        response.end();
        return;
    }

    send({ ...sync.state, available: true });
    const unsubscribe = sync.subscribe((state) => {
        send({ ...state, available: true });
    });

    // Proxies and browsers drop a stream that says nothing for long enough, and a sync's quietest
    // stretch is a minute between pages.
    const keepAlive = setInterval(() => {
        response.write(': keep-alive\n\n');
    }, 20_000);

    const stop = (): void => {
        clearInterval(keepAlive);
        unsubscribe();
    };
    request.on('close', stop);
    response.on('close', stop);
}
