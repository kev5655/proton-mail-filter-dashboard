import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The four questions, shared with `scripts/smoke/archive.mjs` so an image and an archive cannot
// quietly come to mean different things.
// @ts-expect-error — plain JavaScript with no declarations; it is a build script, not a package.
import { questions } from '../../../scripts/smoke/checks.mjs';

/**
 * The container image, started for real.
 *
 * **This is skipped unless it is asked for**, and that is not timidity. Building the image takes
 * minutes and needs a network the ordinary suite has no business requiring; a test that did it on
 * every run would be one people learn to interrupt. It runs when `PMS_E2E_IMAGE` is set — in CI
 * after the image is built, and by hand with:
 *
 *   PMS_E2E_IMAGE=1 pnpm test:e2e
 *   PMS_E2E_IMAGE=1 PMS_IMAGE=proton-mail-sorter:smoke PMS_E2E_IMAGE_BUILD=0 pnpm test:e2e
 *
 * What it proves that a unit test cannot: the entry point starts under the image's own environment,
 * the dashboard is served from `PMS_WEB_ROOT` rather than by vite, the native database driver
 * loaded for *this* platform, and a container with an empty volume comes up **locked** rather than
 * showing an empty mailbox to whoever opened it.
 *
 * It never reaches Proton. A fresh volume has no session to reach it with.
 *
 * **The questions are asked from inside the container.** The server binds `127.0.0.1`, and inside a
 * container that is the container's own loopback — which a published port does not reach, because
 * `docker run -p` forwards to the container's network interface instead. The binding is correct: the
 * Tailscale sidecar shares this namespace in the deployment. So `scripts/smoke/inside.mjs` is run
 * through `docker exec` once, and each test reads its own line out of that run.
 */

const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TAG = process.env['PMS_IMAGE'] ?? 'proton-mail-sorter:e2e';
const PLATFORM =
    process.env['PMS_IMAGE_PLATFORM'] ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const NAME = `pms-e2e-${String(process.pid)}`;

const asked = process.env['PMS_E2E_IMAGE'] === '1';
const shouldBuild = process.env['PMS_E2E_IMAGE_BUILD'] !== '0';

interface Question {
    what: string;
    check: () => Promise<boolean>;
}

/** The shared list, typed at the one place it crosses out of plain JavaScript. */
const ask = (at: string): Question[] => questions(at) as Question[];

let answers: string;
let data: string;
let started = false;

describe.runIf(asked)('the container image', () => {
    beforeAll(async () => {
        data = await mkdtemp(join(tmpdir(), 'pms-e2e-image-'));

        if (shouldBuild) {
            await run('docker', ['build', '--platform', PLATFORM, '-t', TAG, ROOT], {
                maxBuffer: 64 * 1024 * 1024,
            });
        }

        await run('docker', [
            'run', '--detach',
            '--name', NAME,
            '--platform', PLATFORM,
            '--volume', `${data}:/app/data`,
            '--volume', `${join(ROOT, 'scripts', 'smoke')}:/smoke:ro`,
            '--env', 'PMS_AUTO_SYNC=0',
            TAG,
        ]);
        started = true;

        // One run, inside the namespace, whose output every test below reads. Running it per test
        // would restart the wait each time for no more confidence.
        answers = (await run('docker', ['exec', NAME, 'node', '/smoke/inside.mjs'], {
            maxBuffer: 16 * 1024 * 1024,
        })).stdout;
        // 15 minutes on the hook: an emulated build is slow, and a timeout here would read as a
        // broken image rather than as a slow machine.
    }, 900_000);

    afterAll(async () => {
        if (started) {
            await run('docker', ['rm', '--force', '--time', '20', NAME]).catch(() => undefined);
        }
        if (data !== undefined) {
            await rm(data, { recursive: true, force: true });
        }
    }, 60_000);

    // Driven from the shared list, so adding a question adds it here too — which is the whole
    // reason `checks.mjs` exists. The base URL is a placeholder: only the names are used, and the
    // answers come from the run inside the container.
    for (const { what } of ask('http://names-only')) {
        it(what, () => {
            expect(answers).toContain(`✓ ${what}`);
        });
    }

    it('keeps the mailbox out of the image itself', async () => {
        // `data/` is a mount point, not content. An image carrying somebody's encrypted mailbox
        // would be an image that must never be pushed — and this one is pushed to a registry.
        const { stdout } = await run('docker', [
            'run', '--rm', '--platform', PLATFORM, '--entrypoint', 'sh', TAG,
            '-c', 'ls -A /app/data 2>/dev/null | wc -l',
        ]);
        expect(stdout.trim()).toBe('0');
    });

    it('runs as somebody other than root', async () => {
        const { stdout } = await run('docker', [
            'run', '--rm', '--platform', PLATFORM, '--entrypoint', 'id', TAG, '-u',
        ]);
        expect(stdout.trim()).not.toBe('0');
    });
});
