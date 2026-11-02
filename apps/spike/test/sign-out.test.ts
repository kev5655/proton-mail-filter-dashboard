import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtonHttp } from '@pms/proton-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteLocalCopy } from '../src/local-data.js';

/**
 * Signing out, and the reason the order is the whole feature.
 *
 * Deleting the stored session file is the obvious step and on its own it does almost nothing: the
 * tokens live in `ProtonHttp`'s memory from the one read at startup, so a running server would keep
 * syncing on its timer and would keep being able to write. A sign-out that looks like security and
 * is not would be worse than no button at all.
 *
 * `signOut` itself lives in `apps/spike/src/session.ts` and reaches for the repository's own data
 * directory, so what is tested here is the part that can be isolated: that a cleared client really
 * cannot talk to Proton any more, and that removing the local copy removes all of it.
 */

interface Call {
    method: string;
    path: string;
}

function recordingHttp(): { http: ProtonHttp; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({
            method: init?.method ?? 'GET',
            path: new URL(String(input)).pathname.replace(/^\/api\//, ''),
        });
        return new Response(JSON.stringify({ Code: 1000, Labels: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    const http = new ProtonHttp({ version: 'test', fetchImpl, minIntervalMs: 0, jitterMs: 0, maxAttempts: 1 });
    http.setSession({ uid: 'u', accessToken: 'a', refreshToken: 'r' });
    return { http, calls };
}

describe('a cleared client', () => {
    it('cannot reach Proton any more', async () => {
        // The sharp edge, stated as a test. Before this, "logging out" removed a file and left a
        // process that kept reading the mailbox every five minutes with the tokens it already had.
        const { http, calls } = recordingHttp();

        http.setSession(undefined);

        await expect(
            http.request({ method: 'GET', path: 'core/v4/labels' }, { parse: (value: unknown) => value } as never)
        ).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it('could reach it a moment earlier, or the test above proves nothing', async () => {
        const { http, calls } = recordingHttp();

        await http
            .request({ method: 'GET', path: 'core/v4/labels' }, { parse: (value: unknown) => value } as never)
            .catch(() => undefined);

        expect(calls.map((call) => call.path)).toEqual(['core/v4/labels']);
    });
});

describe('removing the local copy', () => {
    let directory: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'pms-wipe-'));
    });

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it('takes the whole database, not just the file with the obvious name', async () => {
        // SQLite in WAL mode keeps `-wal` and `-shm` beside the database, and a `-wal` left next to
        // a fresh one is a corruption path rather than a leftover. The `.kdf.json` holds the salt
        // the key is derived from and is pointless once the data it unlocks is gone.
        const database = join(directory, 'mailbox.db');
        for (const suffix of ['', '-wal', '-shm', '.kdf.json']) {
            await writeFile(`${database}${suffix}`, 'x');
        }

        await deleteLocalCopy(database);

        expect(await readdir(directory)).toEqual([]);
    });

    it('is not an error when there is nothing to remove', async () => {
        // Disconnecting twice is a reasonable thing to do, and so is disconnecting a tool that was
        // never connected.
        await expect(deleteLocalCopy(join(directory, 'mailbox.db'))).resolves.toBeDefined();
    });
});
