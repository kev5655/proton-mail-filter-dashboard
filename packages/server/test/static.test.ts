import { resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fileFor } from '../src/static.js';

/**
 * The path handling in front of the packaged dashboard.
 *
 * A request path is text somebody else wrote, and `data/` — the encrypted mailbox, the session, the
 * account file — sits a short way up from the web root. `..` in a URL is the oldest way there is to
 * read a file nobody meant to publish, and it is the one thing this function exists to refuse.
 *
 * The tests are written against the answer rather than the mechanism: whatever comes back must be
 * inside the root, or nothing.
 */

const ROOT = resolve('/srv/app/web');

function inside(path: string | undefined): boolean {
    return path !== undefined && (path === ROOT || path.startsWith(ROOT + sep));
}

describe('what a request path may reach', () => {
    it('resolves an ordinary file', () => {
        expect(fileFor(ROOT, '/index.html')).toBe(resolve(ROOT, 'index.html'));
        expect(fileFor(ROOT, '/assets/app.js')).toBe(resolve(ROOT, 'assets/app.js'));
    });

    it.each([
        '/../data/mailbox.db',
        '/../../etc/passwd',
        '/assets/../../data/session.enc.json',
        '/..%2f..%2fdata%2fmailbox.db',
        '/%2e%2e/%2e%2e/data/mailbox.db',
        '/....//data/mailbox.db',
    ])('cannot climb out with %s', (path) => {
        /*
         * Two outcomes are correct and one is not.
         *
         * A `..` may be *neutralised* — normalising `/../data/x` gives `/data/x`, which then names
         * a file inside the web root that almost certainly does not exist — or the path may be
         * refused outright. What must never happen is a path that lands outside the root, and that
         * is the whole assertion.
         *
         * The `startsWith` check in the implementation is belt and braces: the normalisation
         * already strips a leading `..`, and the check is there so that a change to the
         * normalisation cannot quietly open a hole.
         */
        const found = fileFor(ROOT, path);

        expect(inside(found) || found === undefined).toBe(true);
    });

    it('refuses a null byte, which can truncate a path in the layer below', () => {
        expect(fileFor(ROOT, '/index.html\0.png')).toBeUndefined();
    });

    it('refuses an undecodable path rather than guessing at it', () => {
        expect(fileFor(ROOT, '/%E0%A4%A')).toBeUndefined();
    });

    it('never leaves the root, whatever it is handed', () => {
        const paths = [
            '/',
            '//',
            '/./',
            '/a/b/c',
            '/..',
            '/../..',
            '/%2e%2e%2f%2e%2e%2fetc/passwd',
            '/a/../../..',
        ];

        for (const path of paths) {
            const found = fileFor(ROOT, path);
            expect(inside(found) || found === undefined, path).toBe(true);
        }
    });
});
