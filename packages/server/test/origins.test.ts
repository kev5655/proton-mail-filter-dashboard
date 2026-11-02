import { describe, expect, it } from 'vitest';

import { refuseForeignOrigin } from '../src/origins.js';

/**
 * Who this server takes instructions from.
 *
 * There was no answer to that question at all: no CSRF token, no `Origin` check, and the `Host`
 * header was never read. On loopback that was tolerable by accident — a process on this machine
 * having the mailbox is the premise of the design — and it stops being tolerable the moment the
 * server is reachable over a tailnet, where every browser tab on every device of yours can reach
 * the port and `/api/apply` is the whole write path.
 *
 * The case that keeps this rule honest is the development one. `pnpm dev` serves the page from vite
 * on another port and proxies here with `changeOrigin: false`, so the request that arrives carries
 * `http://localhost:5173`. A rule pinned to one exact port would have locked the author out of his
 * own dashboard, and the failure would have looked like a broken server rather than a policy.
 */

function post(origin: string | undefined, host?: string, publicOrigin?: string): number | undefined {
    return refuseForeignOrigin('POST', { origin, host }, publicOrigin === undefined ? {} : { publicOrigin })
        ?.status;
}

describe('reading', () => {
    it('is never refused, because a GET changes nothing', () => {
        expect(refuseForeignOrigin('GET', { origin: 'https://boese.example' })).toBeUndefined();
        expect(refuseForeignOrigin('HEAD', { origin: 'https://boese.example' })).toBeUndefined();
    });

    it('includes the streams, which are GETs and must keep working', () => {
        expect(refuseForeignOrigin('GET', {})).toBeUndefined();
    });
});

describe('writing', () => {
    it('is allowed from the page this server serves', () => {
        expect(post('http://127.0.0.1:5174', '127.0.0.1:5174')).toBeUndefined();
    });

    it('is allowed from vite on its own port, which is how development works', () => {
        // `changeOrigin: false` in the proxy, so both headers are still the browser's.
        expect(post('http://localhost:5173', 'localhost:5173')).toBeUndefined();
    });

    it('is allowed from the origin this installation was told to expect', () => {
        expect(post('https://pi.tailnet.ts.net', 'pi.tailnet.ts.net', 'https://pi.tailnet.ts.net')).toBeUndefined();
    });

    it('is refused from a page on the internet, which is the whole point', () => {
        expect(post('https://boese.example', '127.0.0.1:5174')).toBe(403);
    });

    it('is refused from a tailnet name this installation was not told about', () => {
        expect(post('https://anderer.tailnet.ts.net', '127.0.0.1:5174', 'https://pi.tailnet.ts.net')).toBe(403);
    });

    it('is refused with no origin at all', () => {
        // Every browser sends one on a POST. Its absence means the request did not come from a
        // page, and this server is only ever driven by one.
        expect(post(undefined, '127.0.0.1:5174')).toBe(403);
        expect(post('', '127.0.0.1:5174')).toBe(403);
    });

    it('is refused when the host is a name that merely resolves here', () => {
        // The origin check already catches this, since the browser sends the attacker's origin.
        // Re-checking the host costs one comparison and closes the shape rather than arguing that
        // the other check covers it.
        expect(post('http://localhost:5173', 'rebind.boese.example')).toBe(403);
    });

    it('does not care which port the host header carries', () => {
        expect(post('http://localhost:5173', 'localhost:9999')).toBeUndefined();
    });

    it('says which of the checks refused it, so a misconfiguration is findable', () => {
        const reply = refuseForeignOrigin('POST', { origin: 'https://boese.example', host: 'localhost' });

        expect(reply?.body).toMatchObject({ code: 'SERVER_ORIGIN_REFUSED' });
        expect((reply?.body as { detail: string }).detail).toContain('Origin');
    });

    it('treats every other method the same way', () => {
        for (const method of ['PUT', 'PATCH', 'DELETE']) {
            expect(refuseForeignOrigin(method, { origin: 'https://boese.example' })?.status).toBe(403);
        }
    });

    it('does not take an https loopback page for a known one', () => {
        // Somebody running their own TLS proxy is welcome to say so through `publicOrigin`.
        // Guessing on their behalf would widen the rule for a caller nobody has.
        expect(post('https://localhost:5174', 'localhost:5174')).toBe(403);
    });
});
