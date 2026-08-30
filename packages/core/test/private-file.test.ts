import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeOwnership, isOwnerOnly, writePrivateFile } from '../src/private-file.js';

/**
 * Files only their owner may read.
 *
 * This exists because the obvious way is wrong in a way that passes its own test. Passing `mode` to
 * `writeFile` sets permissions when the file is *created* and silently ignores them when it already
 * exists — so a session file that was once world-readable stays world-readable through every
 * rewrite, and a test that creates a fresh file each time never notices.
 *
 * It was noticed here only because the suite happened to run in an order where an earlier test had
 * already created the file. The case below makes that the point rather than an accident.
 *
 * The question is asked through `isOwnerOnly` rather than by comparing a mode, because a mode means
 * nothing on Windows — `stat` reports one invented from the read-only flag, so `mode === 0o600`
 * there is a test that passes without checking anything.
 */

let directory: string;
let path: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-private-'));
    path = join(directory, 'secret.json');
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

describe('writing a private file', () => {
    it('creates it readable only by its owner', async () => {
        await writePrivateFile(path, 'geheim');

        // The evidence goes in the failure message. On Windows the answer depends on how icacls
        // names the account, which is not something anyone should have to guess from a boolean.
        expect(await isOwnerOnly(path), await describeOwnership(path)).toBe(true);
    });

    it('reports what the system says, so a failure can be diagnosed', async () => {
        await writePrivateFile(path, 'geheim');

        const description = await describeOwnership(path);

        expect(description).not.toBe('');
        expect(description).not.toContain('nicht feststellbar');
    });

    it.skipIf(!posix)('tightens a file that already exists with loose permissions', async () => {
        // The real bug. `writeFile` with a mode would leave this at 666 and report success.
        await writeFile(path, 'alt');
        await chmod(path, 0o666);

        await writePrivateFile(path, 'neu');

        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it.skipIf(!posix)('tightens it even when the file is world-writable', async () => {
        await writeFile(path, 'alt');
        await chmod(path, 0o777);

        await writePrivateFile(path, 'neu');

        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it('creates the directory, so a caller need not remember to', async () => {
        const nested = join(directory, 'tief', 'drin', 'secret.json');

        await writePrivateFile(nested, 'geheim');

        expect((await stat(nested)).isFile()).toBe(true);
    });

    it('replaces the contents rather than appending', async () => {
        const { readFile } = await import('node:fs/promises');
        await writePrivateFile(path, 'erst');
        await writePrivateFile(path, 'dann');

        expect(await readFile(path, 'utf8')).toBe('dann');
    });
});
