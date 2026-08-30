import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtonHttp } from '../src/http.js';
import { backupBeforeWrite } from '../src/write/backup.js';

/**
 * The backup taken before every write.
 *
 * It holds every filter and folder name in the account, which is as personal as the mail itself —
 * so its permissions matter as much as the session file's.
 *
 * This used to be checked by grepping `backup.ts` for the string `0o600`. That is the kind of test
 * that passes while the thing it describes is broken: the mode passed to `writeFile` is ignored for
 * a file that already exists, so the literal was present and the guarantee was not. Checking the
 * file on disk is the only version of this test worth having.
 */

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-backup-'));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

function fakeProton(): ProtonHttp {
    const fetchImpl = (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        const body = url.pathname.endsWith('mail/v4/filters')
            ? { Code: 1000, Filters: [] }
            : { Code: 1000, Labels: [{ ID: 'l1', Name: 'Rechnungen', Path: 'Rechnungen', Type: 3 }] };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as typeof fetch;

    return new ProtonHttp({ version: '0.0.0', fetchImpl, minIntervalMs: 0, jitterMs: 0 });
}

describe('backing up before a write', () => {
    it('writes a file only its owner can read', async () => {
        const result = await backupBeforeWrite(fakeProton(), directory, Date.UTC(2026, 0, 2, 3, 4, 5));

        expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    });

    it('names the file after the moment it was taken, so two never collide', async () => {
        await backupBeforeWrite(fakeProton(), directory, Date.UTC(2026, 0, 2, 3, 4, 5));
        await backupBeforeWrite(fakeProton(), directory, Date.UTC(2026, 0, 2, 3, 4, 6));

        expect(await readdir(directory)).toHaveLength(2);
    });

    it('reports what it saved, so a caller can say it in the confirmation', async () => {
        const result = await backupBeforeWrite(fakeProton(), directory, Date.now());

        expect(result.folders).toBe(1);
        expect(result.filters).toBe(0);
    });
});
