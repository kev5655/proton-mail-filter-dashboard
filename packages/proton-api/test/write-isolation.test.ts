import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The project's core rule, enforced instead of documented.
 *
 * CLAUDE.md says the tool never moves mail and that only `src/write/` may issue a non-GET request.
 * A rule of that kind is worth exactly as much as its enforcement: it is easy to obey while writing
 * the module that states it, and easy to forget six weeks later while fixing something urgent.
 *
 * So this walks the source and checks it. The two things it protects:
 *
 * Directories named `test` and `e2e` are skipped. Those rules are about what ships: an end-to-end
 * harness has to stand a server up and seed a database, which means importing the very modules the
 * application is forbidden from touching. Testing the rule requires being able to break it.
 *
 *  - **No write outside `src/write/`.** A POST added elsewhere would bypass the diff, the backup and
 *    the confirmation, all of which live above that boundary.
 *  - **`write/messages.ts` has exactly two importers.** Moving mail is the documented exception to
 *    the core rule — undo, and moving into one of Proton's categories — and the set is asserted as
 *    an exact set rather than as a filter, so it cannot be widened by adding a line. An exception
 *    that anything may reach is not an exception, it is the new behaviour.
 *  - **The browser goes to the login page and nowhere else.** A browser is a second way to reach
 *    Proton, and one that no amount of HTTP-level checking can see: a page can be driven to the
 *    mailbox and told to click things. The rule is about Proton, not about `fetch`, so the check
 *    has to cover both.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

/** Directories whose code talks to Proton. Adding one here is a deliberate act. */
const SOURCE_ROOTS = ['packages', 'apps'];

/** A request that changes something. */
const WRITE_METHODS = /method:\s*'(POST|PUT|DELETE|PATCH)'/;

/**
 * Whether the file is talking to *Proton*, as opposed to some other service.
 *
 * The first version of this test flagged the Ollama adapter, which posts to a local language model
 * and has nothing to do with anyone's mailbox. Widening the exception list would have been the easy
 * fix and the wrong one: the rule is about Proton, so the check should be too.
 */
const TALKS_TO_PROTON = /(mail\/v[0-9]|core\/v[0-9]|auth\/(refresh|v[0-9])|ProtonHttp)/;

async function sourceFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
        entries.map(async (entry) => {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', 'dist', 'vendor', 'test', 'e2e'].includes(entry.name)) {
                    return [];
                }
                return sourceFiles(full);
            }
            return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
        })
    );
    return files.flat();
}

async function allSources(): Promise<string[]> {
    const roots = await Promise.all(SOURCE_ROOTS.map(async (root) => sourceFiles(join(REPO, root))));
    return roots.flat();
}

describe('only src/write may change anything at Proton', () => {
    it('finds no Proton write request outside the write directory', async () => {
        const offenders: string[] = [];

        for (const file of await allSources()) {
            const relativePath = relative(REPO, file);
            if (relativePath.includes(join('proton-api', 'src', 'write'))) {
                continue;
            }

            const source = await readFile(file, 'utf8');
            if (WRITE_METHODS.test(source) && TALKS_TO_PROTON.test(source)) {
                offenders.push(relativePath);
            }
        }

        // The login handshake is the one exception: authenticating is a POST and cannot be avoided.
        expect(offenders.filter((path) => !path.endsWith(join('src', 'auth.ts')))).toEqual([]);
    });

    it('drives the browser to the login page and nowhere else', async () => {
        // Clicking through a real mailbox would move mail while leaving every HTTP-level guard
        // above untouched, which is exactly the kind of hole a written rule does not close.
        //
        // This got *more* important, not less, when the dashboard gained a button that opens the
        // browser: the window is now started by an HTTP request instead of by somebody at a
        // terminal, and it runs in a real profile that is already signed in to other things. A URL
        // added here would be a page that request could reach.
        const allowed = new Set(['https://account.proton.me/login']);
        const found = new Set<string>();

        for (const file of await allSources()) {
            if (!relative(REPO, file).includes(join('browser-auth', 'src'))) {
                continue;
            }
            const source = await readFile(file, 'utf8');
            for (const match of source.matchAll(/https:\/\/[a-z0-9.-]*proton\.me[^'"`\s]*/g)) {
                found.add(match[0]);
            }
        }

        expect(found.size).toBeGreaterThan(0);
        expect([...found].filter((url) => !allowed.has(url))).toEqual([]);
    });

    it('lets exactly two services reach the message-moving module', async () => {
        const importers: string[] = [];

        for (const file of await allSources()) {
            const relativePath = relative(REPO, file);
            if (relativePath.endsWith(join('write', 'messages.ts'))) {
                continue;
            }

            const source = await readFile(file, 'utf8');
            if (/from '.*write\/messages(\.js)?'/.test(source)) {
                importers.push(relativePath);
            }
        }

        // An exact set, not a filter with an allowlist beside it. The difference is what happens
        // six weeks from now: adding a third mover has to change this line, in a file whose whole
        // subject is why there are only two.
        expect(importers.sort()).toEqual([
            join('packages', 'changes', 'src', 'category-service.ts'),
            join('packages', 'changes', 'src', 'undo-service.ts'),
        ]);
    });

    it('gives every mail-moving function an explicit list of ids to move', async () => {
        // "Only ids the user saw" as a signature rather than as a promise. A function taking a
        // folder, a sender or a query could sweep up mail nobody named, and no amount of care
        // further up would see it happen.
        const source = await readFile(
            join(REPO, 'packages', 'proton-api', 'src', 'write', 'messages.ts'),
            'utf8'
        );

        const exported = [...source.matchAll(/export async function (\w+)\(([^)]*)\)/gs)];
        expect(exported.map((match) => match[1]).sort()).toEqual([
            'moveMessagesBack',
            'moveMessagesToCategory',
        ]);
        for (const [, name, parameters] of exported) {
            expect(parameters, name).toMatch(/messageIds:\s*string\[\]/);
        }
    });

    it('leaves the category service no way to find an id for itself', async () => {
        // It is handed ids and reads their state through an injected function. If it could ask
        // Proton which messages exist, "only what the user selected" would depend on nobody ever
        // writing the convenient version.
        const source = await readFile(
            join(REPO, 'packages', 'changes', 'src', 'category-service.ts'),
            'utf8'
        );

        expect(source).not.toMatch(/getMessages|readMessages|LabelIDs\s*\?*\.|mail\/v[0-9]/);
    });

    it('keeps the message-moving module out of the write barrel', async () => {
        // Exporting it alongside the ordinary writes would make it reachable by autocomplete, which
        // is how an exception stops being one.
        const barrel = await readFile(
            join(REPO, 'packages', 'proton-api', 'src', 'write', 'index.ts'),
            'utf8'
        );

        expect(barrel).not.toMatch(/export .* from '\.\/messages/);
    });

    it('backs up before writing', async () => {
        const backup = await readFile(
            join(REPO, 'packages', 'proton-api', 'src', 'write', 'backup.ts'),
            'utf8'
        );

        expect(backup).toContain('backupBeforeWrite');
    });
});


/**
 * The write path, once it became real.
 *
 * The rules above were written while nothing could write. These are about the arrangement that now
 * can: one file performs the writes, a different one parses the HTTP that asks for them, and the
 * two must not be able to reach each other. That is the structural form of "an HTTP request is an
 * offer, not a trigger" — a sentence in a comment would not survive a hurried afternoon.
 */
describe('the write path stays where it was put', () => {
    it('lets only the executor import the write barrel', async () => {
        const importers: string[] = [];

        for (const file of await allSources()) {
            const relativePath = relative(REPO, file);
            if (relativePath.includes(join('proton-api', 'src', 'write'))) {
                continue;
            }
            const source = await readFile(file, 'utf8');
            if (/from '@pms\/proton-api\/write'/.test(source)) {
                importers.push(relativePath);
            }
        }

        // One file to read when someone asks what this tool can change.
        expect(importers).toEqual([join('packages', 'apply', 'src', 'steps.ts')]);
    });

    it('keeps the routing code away from the code that performs anything', async () => {
        // The file that parses a request must be incapable of acting on it. They meet through a
        // channel object handed in from outside, which is what makes the confirmation unskippable.
        for (const name of ['handler.ts', 'sync-channel.ts', 'serve.ts']) {
            const source = await readFile(join(REPO, 'packages', 'server', 'src', name), 'utf8');

            expect(source, name).not.toMatch(/@pms\/apply/);
            expect(source, name).not.toMatch(/@pms\/proton-api\/write/);
            expect(source, name).not.toMatch(/@pms\/changes\/undo/);
        }
    });

    it('never writes without a backup in the same module', async () => {
        const steps = await readFile(join(REPO, 'packages', 'apply', 'src', 'steps.ts'), 'utf8');

        // If the writes ever move somewhere the backup does not, this fails rather than the backup
        // quietly becoming optional.
        expect(steps).toMatch(/backupBeforeWrite/);
    });

    it('never writes without asking, and asks somewhere HTTP cannot reach', async () => {
        const apply = await readFile(join(REPO, 'packages', 'apply', 'src', 'apply.ts'), 'utf8');

        // The confirmation is awaited before the first write, and the writes live behind steps.js.
        const confirmAt = apply.indexOf('context.confirm(');
        const writeAt = apply.indexOf('await perform(');
        expect(confirmAt).toBeGreaterThan(-1);
        expect(writeAt).toBeGreaterThan(confirmAt);
    });

    it('keeps the undo service out of the changes barrel', async () => {
        // apps/web imports @pms/changes. Re-exporting undo there would pull a Proton write module
        // into the browser bundle — reachable by autocomplete, which is how an exception ends.
        const barrel = await readFile(join(REPO, 'packages', 'changes', 'src', 'index.ts'), 'utf8');

        expect(barrel).not.toMatch(/undo-service/);
    });

    it('keeps the dashboard away from the Proton client entirely', async () => {
        const offenders: string[] = [];

        for (const file of await allSources()) {
            const relativePath = relative(REPO, file);
            if (!relativePath.startsWith(join('apps', 'web'))) {
                continue;
            }
            const source = await readFile(file, 'utf8');
            if (/from '@pms\/proton-api/.test(source)) {
                offenders.push(relativePath);
            }
        }

        // Its Proton-shaped types come from @pms/server/types, which is types only. A type import
        // here would be one keystroke from a value import.
        expect(offenders).toEqual([]);
    });
});


/**
 * The login the dashboard can start, and the two things that keep it narrow.
 *
 * It is the third non-GET route in a project that promised two, and the most consequential thing
 * the tool does. What makes it defensible is not the route count: it is that this process never
 * sees a password — it opens Proton's own form in a real browser profile and waits — and that
 * `LoginGuard` still decides whether an attempt may happen at all.
 */
describe('signing in from the dashboard', () => {
    it('never asks the credential source for a password', async () => {
        // `connect()` fetches the username and password and hands them to Playwright to type. The
        // browser-driven login must not: a password manager's extension fills Proton's own form,
        // and what this process never receives it cannot leak, log or mistype.
        const source = await readFile(join(REPO, 'packages', 'browser-auth', 'src', 'login.ts'), 'utf8');
        const byHand = source.slice(source.indexOf('export async function loginByHandInBrowser'));

        expect(byHand).not.toMatch(/options\.password|fill\(page, 'password'/);
        expect(byHand).toContain('PROTON_LOGIN_URL');
    });

    it('asks the guard before it opens anything', async () => {
        // A button in a web interface makes a login easy to hammer, which is how this account
        // earned a lockout. The guard is consulted first, and a refusal is a refusal.
        const session = await readFile(join(REPO, 'apps', 'spike', 'src', 'session.ts'), 'utf8');
        const fn = session.slice(session.indexOf('export async function loginInBrowser'));

        const guardAt = fn.indexOf('assertMayAttempt');
        const openAt = fn.indexOf('loginByHandInBrowser');
        expect(guardAt).toBeGreaterThan(-1);
        expect(openAt).toBeGreaterThan(guardAt);
    });

    it('records the failure so the guard can count it', async () => {
        const session = await readFile(join(REPO, 'apps', 'spike', 'src', 'session.ts'), 'utf8');
        const fn = session.slice(session.indexOf('export async function loginInBrowser'));

        expect(fn).toContain('recordFailure');
        // And no retry loop around it. One attempt, then stop — the rule that got this account back.
        expect(fn).not.toMatch(/for \(|while \(|retry/);
    });

    it('keeps the server unable to perform one', async () => {
        // Same shape as sync and apply: the routing file knows a login was asked for and nothing
        // about how one is done. The runner comes from the process that holds the session.
        const channel = await readFile(join(REPO, 'packages', 'server', 'src', 'session-channel.ts'), 'utf8');

        expect(channel).not.toMatch(/@pms\/browser-auth|playwright/);
    });
});
