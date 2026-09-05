import type { IncomingMessage, ServerResponse } from 'node:http';

import { getLogger } from '@pms/core/logger';

const log = getLogger('server');

/**
 * Ollama, under the dashboard's own origin.
 *
 * Vite does this in development, and the reason is written out in `apps/web/vite.config.ts`: Ollama
 * answers only requests whose `Origin` it was configured to allow, so a page served from anywhere
 * else gets a network error indistinguishable from „nothing is listening". A packaged copy has no
 * vite, so it carries the same proxy rather than asking every user to widen a service's access
 * rules to accommodate this page.
 *
 * **It forwards to one configured address and nowhere else.** The path after `/ollama` is appended,
 * the host is never taken from the request, and nothing about the incoming URL can redirect it — a
 * proxy that took its target from a parameter would turn this loopback server into a way to reach
 * anything the machine can reach.
 */
const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';

export async function proxyToOllama(
    baseUrl: string | undefined,
    request: IncomingMessage,
    response: ServerResponse,
    path: string
): Promise<void> {
    const base = (baseUrl ?? DEFAULT_OLLAMA).replace(/\/$/, '');
    const target = `${base}${path.slice('/ollama'.length) || '/'}`;

    try {
        const body =
            request.method === 'GET' || request.method === 'HEAD' ? undefined : await readAll(request);
        const answer = await fetch(target, {
            method: request.method ?? 'GET',
            headers: { 'Content-Type': request.headers['content-type'] ?? 'application/json' },
            ...(body === undefined ? {} : { body }),
        });

        response.writeHead(answer.status, {
            'Content-Type': answer.headers.get('content-type') ?? 'application/json',
            'Cache-Control': 'no-store',
        });
        response.end(Buffer.from(await answer.arrayBuffer()));
    } catch (cause) {
        // Nothing listening is the ordinary case — a model is optional — so this is a 502 with a
        // sentence rather than an error the dashboard has to decode.
        log.debug({ target, cause }, 'ollama is not answering');
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(
            JSON.stringify({ error: 'Ollama antwortet nicht.', code: 'LLM_UNAVAILABLE' })
        );
    }
}

async function readAll(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}
