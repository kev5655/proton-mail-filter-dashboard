import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePrivateFile } from '../src/private-file.js';

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

async function permissions(): Promise<string> {
    return ((await stat(path)).mode & 0o777).toString(8);
}

describe('writing a private file', () => {
    it('creates it readable only by its owner', async () => {
        await writePrivateFile(path, 'geheim');

        expect(await permissions()).toBe('600');
    });

    it('tightens a file that already exists with loose permissions', async () => {
        // The real bug. `writeFile` with a mode would leave this at 666 and report success.
        await writeFile(path, 'alt');
        await chmod(path, 0o666);

        await writePrivateFile(path, 'neu');

        expect(await permissions()).toBe('600');
    });

    it('tightens it even when the file is world-writable and group-owned', async () => {
        await writeFile(path, 'alt');
        await chmod(path, 0o777);

        await writePrivateFile(path, 'neu');

        expect(await permissions()).toBe('600');
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
