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

        // Nothing imports it yet; when the undo service lands, it and only it belongs on this list.
        const allowed = new Set([join('packages', 'changes', 'src', 'undo-service.ts')]);
        expect(importers.filter((path) => !allowed.has(path))).toEqual([]);
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

    it('backs up before writing, and says so where a reader will look', async () => {
        const backup = await readFile(
            join(REPO, 'packages', 'proton-api', 'src', 'write', 'backup.ts'),
            'utf8'
        );

        expect(backup).toContain('backupBeforeWrite');
        // 0600: the backup contains every filter and folder name, which is as personal as the mail.
        expect(backup).toContain('0o600');
    });
});
