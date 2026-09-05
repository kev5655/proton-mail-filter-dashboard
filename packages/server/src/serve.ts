import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

import type { AccountChannel } from './account-channel.js';
import { proxyToOllama } from './ollama-proxy.js';
import { serveStatic } from './static.js';
import type { ApplyChannel } from './apply-channel.js';
import { route, STREAM_PATHS } from './handler.js';
import type { SessionChannel } from './session-channel.js';
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
    /**
     * The mailbox, once it can be opened.
     *
     * A function rather than a value, because the server now starts before anything is unlocked and
     * the database appears partway through its life. Passing the handle at construction would have
     * meant either starting no server until somebody has typed a password — leaving the dashboard
     * with nothing to talk to and no way to ask for one — or handing over a handle that is replaced
     * behind the caller's back.
     */
    db: Db | undefined | (() => Db | undefined);
    /** 0 asks the operating system for a free one, which is what the tests use. */
    port?: number;
    host?: string;
    /** Absent when this server has no way to reach Proton — then no sync can be started. */
    sync?: SyncChannel | undefined;
    /** Absent when nothing may be written — then a change can be offered but never accepted. */
    apply?: ApplyChannel | undefined;
    /** Absent when this process cannot open a browser — then the dashboard says so and offers none. */
    login?: SessionChannel | undefined;
    /** Absent when nothing guards this installation — then the dashboard shows no lock screen. */
    account?: AccountChannel | undefined;
    /**
     * Where the built dashboard lives, for a packaged copy.
     *
     * Absent in development, where vite serves the page and proxies `/api` here. Present in a
     * downloaded copy, where this process does both — which is not a compromise: same origin means
     * the browser never has to be told which origins may read one account's mailbox.
     */
    webRoot?: string | undefined;
    /**
     * Where Ollama is, for the same reason.
     *
     * Vite proxies `/ollama` in development because Ollama answers only requests whose `Origin` it
     * was configured to allow, and a page served from somewhere else is not one of them. The
     * packaged app has no vite, so it carries the same proxy — the alternative is telling every
     * user to widen a service's access rules to accommodate this page.
     */
    ollamaUrl?: string | undefined;
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

        if (path === '/ollama' || path.startsWith('/ollama/')) {
            void proxyToOllama(options.ollamaUrl, request, response, path);
            return;
        }

        /*
         * Anything that is not the API is the page itself.
         *
         * Checked before the routes rather than after, so a dashboard file called `api-something`
         * cannot shadow one — and so an unknown `/api/...` path still gets the router's own 404
         * with a code rather than the application shell with a 200.
         */
        if (options.webRoot !== undefined && !path.startsWith('/api/')) {
            void serveStatic(options.webRoot, request, response, path);
            return;
        }

        if (STREAM_PATHS.has(path)) {
            // Two streams, one shape. A login is mostly waiting — for a window to open, then for a
            // person — and a dashboard that could only poll would either be slow to notice or
            // noisy while nothing happened.
            streamState(
                request,
                response,
                path === '/api/login/stream' ? options.login : options.sync
            );
            return;
        }

        // Only the offer route carries a body, and it is small by construction — a change and the
        // plan the user was shown. The cap is there so a stray upload cannot fill this process's
        // memory; nothing legitimate comes close to it.
        readBody(request, 4_000_000)
            .then(async (body) => {
                await answer(request, response, options, path, body);
            })
            .catch(() => {
                response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
                response.end(JSON.stringify({ error: 'Anfrage zu gross.', code: 'SERVER_BODY_TOO_LARGE' }));
            });
    });

    async function answer(
        request: IncomingMessage,
        response: ServerResponse,
        served: ServeOptions,
        path: string,
        body: unknown
    ): Promise<void> {
        let reply;
        try {
            // The login channel was missing from this list, which made `POST /api/login` answer
            // 503 however well it was wired up at the other end.
            reply = await route(request.method, path, currentDb(served), {
                sync: served.sync,
                apply: served.apply,
                login: served.login,
                account: served.account,
            }, body);
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
    }

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

function currentDb(served: ServeOptions): Db | undefined {
    return typeof served.db === 'function' ? served.db() : served.db;
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
function streamState(
    request: IncomingMessage,
    response: ServerResponse,
    channel:
        | {
              available: boolean;
              signedIn?: boolean;
              nextRunAt?: number | undefined;
              state: unknown;
              subscribe: (listener: (state: unknown) => void) => () => void;
          }
        | undefined
): void {
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

    if (channel === undefined) {
        send({ state: 'idle', available: false });
        response.end();
        return;
    }

    // `signedIn` rides on every event so the interface never has to guess which button to show
    // from the state name — „done" and „idle-with-a-stored-session" look the same otherwise.
    const shape = (state: unknown): object => ({
        ...(state as object),
        available: true,
        ...(channel.signedIn === undefined ? {} : { signedIn: channel.signedIn }),
        // Read at send time rather than captured: the timer restarts on every run, so a value
        // fixed when the stream opened would be wrong from the first sync onwards.
        ...(channel.nextRunAt === undefined ? {} : { nextRunAt: channel.nextRunAt }),
    });

    send(shape(channel.state));
    const unsubscribe = channel.subscribe((state) => {
        send(shape(state));
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

/** The request body as JSON, or undefined when there is none. Capped, and refused above the cap. */
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
    if (request.method !== 'POST') {
        return undefined;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > limit) {
            throw new Error('body too large');
        }
        chunks.push(buffer);
    }

    if (size === 0) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        // Unparseable is not the router's problem; it will refuse an unreadable offer itself.
        return undefined;
    }
}
