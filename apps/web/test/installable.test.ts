import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * What makes the dashboard installable, and the one thing that would make it dishonest.
 *
 * The manifest and the worker are static files that nothing else in the suite loads, so a typo in
 * either fails silently: the page keeps working and simply stops being installable, which nobody
 * notices until they try it on a phone.
 *
 * The assertion that matters is the negative one. Every screen in this app states how old the local
 * copy is and whether it is complete. A service worker that answered an `/api` request from a cache
 * would make that sentence a lie — and an invisible one, because a stale folder list looks exactly
 * like a current one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8')) as {
    display: string;
    start_url: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
};
const worker = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');

describe('the manifest', () => {
    it('asks for a window of its own, which is what „installed" means', () => {
        expect(manifest.display).toBe('standalone');
        expect(manifest.start_url).toBe('/');
    });

    it('offers the two sizes a launcher looks for, and a maskable one', () => {
        const sizes = manifest.icons.map((icon) => icon.sizes);
        expect(sizes).toContain('192x192');
        expect(sizes).toContain('512x512');
        // Without a maskable icon the launcher crops the square and clips the corners off the mark.
        expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    });

    it('names icons that exist', () => {
        for (const icon of manifest.icons) {
            expect(() => readFileSync(join(PUBLIC, icon.src.replace(/^\//, '')))).not.toThrow();
        }
    });
});

describe('the page head', () => {
    it('links the manifest', () => {
        expect(html).toContain('rel="manifest"');
    });

    it('carries an apple-touch-icon, because iOS ignores the manifest icons', () => {
        // Without it the home-screen icon becomes a screenshot of whatever the page showed.
        expect(html).toMatch(/rel="apple-touch-icon"\s+href="\/icon-180\.png"/);
        expect(() => readFileSync(join(PUBLIC, 'icon-180.png'))).not.toThrow();
    });

    it('registers the worker only in a secure context, which is where one is allowed anyway', () => {
        expect(html).toContain('window.isSecureContext');
    });
});

describe('the service worker', () => {
    it('never answers an API request, which would make „so alt ist diese Kopie" a lie', () => {
        expect(worker).toContain("url.pathname.startsWith('/api')");
        expect(worker).toContain("url.pathname.startsWith('/ollama')");
    });

    it('leaves every non-GET alone, because a write is not a thing to replay', () => {
        expect(worker).toContain("request.method !== 'GET'");
    });

    it('asks the network first, so an updated bundle is never withheld', () => {
        // Cache-first would serve yesterday's code to somebody who has just updated, and the
        // symptom is a dashboard whose code and server disagree about a response shape.
        const fetchHandler = worker.slice(worker.indexOf("addEventListener('fetch'"));
        expect(fetchHandler.indexOf('fetch(request)')).toBeLessThan(fetchHandler.indexOf('caches.match'));
    });

    it('does not precache the bundle, whose name changes with every build', () => {
        expect(worker).not.toMatch(/assets\/index-/);
    });
});
