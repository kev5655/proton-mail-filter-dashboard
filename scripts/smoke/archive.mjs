import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { askTheQuestions, somePort, waitForHealth } from './checks.mjs';

/**
 * Start the downloadable copy somewhere it has never been, and ask it the four questions.
 *
 * Copied to a temporary directory first, and that is the point rather than tidiness: what is under
 * test is an archive that has left the build machine. Running it in place would keep the workspace
 * one directory above it, which is exactly the thing that hid the first packaging bug.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = somePort();

const where = await mkdtemp(join(tmpdir(), 'pms-smoke-'));
let child;

try {
    await cp(join(ROOT, 'release'), where, { recursive: true });
    await mkdir(join(where, 'data'), { recursive: true });

    /*
     * The Node that ships, when one does.
     *
     * Testing with the build machine's Node would leave the one thing the archive actually carries
     * unverified — a runtime that does not start, or does not match the native module it was built
     * against, would pass here and fail on the first download.
     */
    const bundled = [join(where, 'node', 'bin', 'node'), join(where, 'node', 'node.exe')].find(
        (candidate) => existsSync(candidate)
    );
    const node = bundled ?? process.execPath;
    console.log(`  · Node: ${bundled === undefined ? 'vom Build-Rechner' : bundled}`);

    child = execFile(node, [join(where, 'app', 'server.mjs'), '--serve'], {
        cwd: where,
        env: {
            ...process.env,
            PMS_SERVER_PORT: String(PORT),
            // A build machine has none of this, but a developer's does — and a smoke test that
            // reached a real 1Password would be asking for a fingerprint in CI.
            PMS_OP_VAULT: '',
            PMS_LOG_FILE: '',
            // The timer has nothing to sync and nobody to tell; it would only add noise.
            PMS_AUTO_SYNC: '0',
        },
    });

    const output = [];
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));

    const base = `http://127.0.0.1:${String(PORT)}`;
    await waitForHealth(base, () => output.join(''));
    await askTheQuestions(base);

    console.log('\n✓ Das Archiv startet, bedient das Dashboard und ist ohne Konto gesperrt.');
} finally {
    child?.kill();
    await rm(where, { recursive: true, force: true });
}
