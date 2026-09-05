/*
 * The service worker, and the one thing it deliberately does not do.
 *
 * It caches the shell — the page, the bundle, the stylesheet, the icons — so the dashboard opens
 * from a home screen without waiting for the server, and so a phone that has briefly lost the
 * tailnet shows something rather than a browser error.
 *
 * **It never caches `/api`.** Every screen in this app states how old the local copy is and whether
 * it is complete; a cached mailbox response would make that sentence a lie, and the lie would be
 * invisible — a stale folder list looks exactly like a current one. The same goes for `/ollama`.
 * When the network is gone, those requests fail, and failing is the honest answer.
 *
 * Nothing here is a substitute for the server. There is no offline mode: the mailbox lives in an
 * encrypted database this page cannot open.
 */

const SHELL = 'pms-shell-v1';

/**
 * What is worth having before it is asked for.
 *
 * Only the entry point and the icons: the bundle's filename carries a content hash that changes
 * with every build, so naming it here would pin a version that no longer exists. It is cached on
 * first use instead, which is one request later and always correct.
 */
const PRECACHE = ['/', '/index.html', '/logo.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(SHELL)
            .then(async (cache) => {
                // Individually, so one missing file does not throw away the whole install.
                await Promise.all(PRECACHE.map(async (path) => cache.add(path).catch(() => undefined)));
            })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then(async (names) => {
                await Promise.all(names.filter((name) => name !== SHELL).map(async (name) => caches.delete(name)));
            })
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
        return;
    }
    // The two paths that must always be answered by the server or not at all.
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ollama')) {
        return;
    }

    /*
     * Network first, cache as the fallback.
     *
     * The other way round would serve yesterday's bundle to somebody who has just updated, and the
     * symptom of that is a dashboard whose code and server disagree about what a response looks
     * like — which is a much worse afternoon than one slow load.
     */
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    void caches.open(SHELL).then(async (cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(async () => {
                const hit = await caches.match(request);
                if (hit !== undefined) {
                    return hit;
                }
                // A navigation with nothing cached for that exact URL still has the shell: this is
                // a single-page app, and every route renders from the same document.
                if (request.mode === 'navigate') {
                    const shell = await caches.match('/index.html');
                    if (shell !== undefined) {
                        return shell;
                    }
                }
                throw new Error('offline');
            })
    );
});
