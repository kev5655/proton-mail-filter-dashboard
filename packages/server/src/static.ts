import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serving the dashboard's own files, for the packaged app.
 *
 * In development vite does this and proxies `/api` to us. A downloaded copy has no vite, so the
 * same process that answers `/api` also hands out the page — which is not a compromise but the
 * better arrangement: same origin, so the browser never has to be told which origins may read one
 * account's mailbox.
 *
 * The path handling is the part worth reading. A request path is attacker-controlled text, and
 * `data/` sits a short way up from the web root; `..` in a URL is the oldest way there is to read a
 * file nobody meant to publish. So the resolved path is checked to be *inside* the root, and a
 * request that is not gets the same answer as one for a file that does not exist.
 */

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

/**
 * The file a request names, or undefined when it names nothing inside the root.
 *
 * Undefined is also the answer for a traversal attempt, deliberately: telling the difference
 * between „that file is not here" and „you may not ask for that" is information nobody outside
 * needs, and this server has exactly one legitimate caller.
 */
export function fileFor(root: string, path: string): string | undefined {
    const decoded = safeDecode(path);
    if (decoded === undefined || decoded.includes('\0')) {
        return undefined;
    }

    const base = resolve(root);
    const target = resolve(base, `.${normalize(decoded)}`);
    return target === base || target.startsWith(base + sep) ? target : undefined;
}

function safeDecode(path: string): string | undefined {
    try {
        return decodeURIComponent(path);
    } catch {
        return undefined;
    }
}

/**
 * Answer with a file, or with the page itself.
 *
 * Anything that is not a file falls back to `index.html`, because the dashboard keeps its state in
 * memory rather than in the URL and a reload of any path has to land on the application. That
 * fallback is what makes it a single-page app rather than a directory listing.
 */
export async function serveStatic(
    root: string,
    request: IncomingMessage,
    response: ServerResponse,
    path: string
): Promise<void> {
    const direct = fileFor(root, path);
    const candidate = direct === undefined ? undefined : await readable(direct);
    const file = candidate ?? (await readable(join(resolve(root), 'index.html')));

    if (file === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Nicht gefunden.');
        return;
    }

    response.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        // The page is one account's mailbox once it has loaded. Nothing may keep a copy of the
        // shell either, or a rebuilt dashboard would be served from a cache indefinitely.
        'Cache-Control': 'no-store',
    });

    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    createReadStream(file).pipe(response);
}

async function readable(path: string): Promise<string | undefined> {
    try {
        return (await stat(path)).isFile() ? path : undefined;
    } catch {
        return undefined;
    }
}
