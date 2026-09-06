import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askTheQuestions, somePort, waitForHealth } from './checks.mjs';

/**
 * Build the container image and ask it the same four questions the archive gets.
 *
 * The same four deliberately. An image and an archive are two shapes of one promise — it starts, it
 * serves the page, it has no account, and the mailbox is locked rather than empty — and the moment
 * those are asked in two places they answer differently and nobody notices which.
 *
 * `--platform` defaults to this machine's own architecture rather than to the Pi's. Under emulation
 * a build takes many minutes and can fail for reasons that have nothing to do with the change being
 * tested; the arm64 image is what CI and the Pi are for. What a native build still proves is
 * everything except the architecture: the entry point, the environment, the web root, the health
 * route, the static server and the locked mailbox.
 *
 *   node scripts/smoke/image.mjs                    # build and check
 *   PMS_IMAGE=kev5655/proton-mail-sorter:latest \
 *     node scripts/smoke/image.mjs --no-build       # check an image that already exists
 */

const execFile = promisify(execFileCallback);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORM = process.env['PMS_IMAGE_PLATFORM'] ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const TAG = process.env['PMS_IMAGE'] ?? 'proton-mail-sorter:smoke';
const NAME = `pms-smoke-${String(process.pid)}`;
const PORT = somePort();
const build = !process.argv.includes('--no-build');

// A directory of its own for the volume, so a failed run cannot leave anything in the workspace and
// so the container is genuinely starting from nothing.
const data = await mkdtemp(join(tmpdir(), 'pms-image-'));
let started = false;

try {
    if (build) {
        console.log(`· Bauen (${PLATFORM}) — das dauert.`);
        await run('docker', ['build', '--platform', PLATFORM, '-t', TAG, ROOT], { inherit: true });
    }

    console.log(`· Starten: ${TAG}`);
    await run('docker', [
        'run', '--detach',
        '--name', NAME,
        '--platform', PLATFORM,
        // Loopback only. The image publishes nothing by itself and neither does this.
        '--publish', `127.0.0.1:${String(PORT)}:5174`,
        '--volume', `${data}:/app/data`,
        // The timer has nothing to sync and nobody to tell.
        '--env', 'PMS_AUTO_SYNC=0',
        TAG,
    ]);
    started = true;

    const base = `http://127.0.0.1:${String(PORT)}`;
    await waitForHealth(base, async () => (await run('docker', ['logs', NAME])).stdout);
    await askTheQuestions(base);

    console.log('\n✓ Das Image startet, bedient das Dashboard und ist ohne Konto gesperrt.');
} finally {
    if (started) {
        // `--time 20` for the same reason the compose file uses it: the server closes its event
        // streams and its database on the way out, and ten seconds ends in a SIGKILL.
        await run('docker', ['rm', '--force', '--time', '20', NAME]).catch(() => undefined);
    }
    await rm(data, { recursive: true, force: true });
}

async function run(command, args, { inherit = false } = {}) {
    if (inherit) {
        return new Promise((resolve_, reject) => {
            const child = execFileCallback(command, args, { maxBuffer: 64 * 1024 * 1024 });
            child.stdout?.pipe(process.stdout);
            child.stderr?.pipe(process.stderr);
            child.on('close', (code) =>
                code === 0 ? resolve_({ stdout: '' }) : reject(new Error(`${command} exit ${String(code)}`))
            );
        });
    }
    return execFile(command, args, { maxBuffer: 64 * 1024 * 1024 });
}
