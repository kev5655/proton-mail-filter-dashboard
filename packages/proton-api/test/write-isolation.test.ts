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
 *  - **No write outside `src/write/`.** A POST added elsewhere would bypass the diff, the backup and
 *    the confirmation, all of which live above that boundary.
 *  - **Nobody imports `write/messages.ts` except the undo service.** Moving mail is the single
 *    documented exception to the core rule; an exception that anything may reach is not an
 *    exception, it is the new behaviour.
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
                if (['node_modules', 'dist', 'vendor', 'test'].includes(entry.name)) {
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

    it('lets nothing but the undo service reach the message-moving module', async () => {
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

        // Exactly one file, and it exists now. Undo is the single documented exception to "this
        // tool never moves mail", and an exception several modules can reach is not one.
        const allowed = new Set([join('packages', 'changes', 'src', 'undo-service.ts')]);
        expect(importers.filter((path) => !allowed.has(path))).toEqual([]);
        expect(importers).toContain(join('packages', 'changes', 'src', 'undo-service.ts'));
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
