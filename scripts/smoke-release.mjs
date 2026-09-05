import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Start the packaged copy somewhere it has never been, and ask it three questions.
 *
 * Not a unit test, and it is separate from the suite for a reason: what it exercises is the
 * *archive*. The bundle, the native module, the built dashboard and the path handling only meet in
 * a directory that has been copied off the build machine, and every one of them has a way to be
 * wrong that no test against the source can see.
 *
 * The first version of this packaging failed exactly here: `paths.ts` looked for the workspace
 * marker above itself and threw when there was none, so a downloaded copy died on its first line
 * while every test stayed green.
 *
 * It never touches Proton. There is no account and no stored session in a fresh directory, so the
 * server comes up locked — which is the state being checked.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5187 + Math.floor(Math.random() * 200);

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
     * against, would pass and then fail on the first download.
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
    await waitFor(`${base}/api/health`, output);

    await expect('the dashboard is served', async () => {
        const answer = await fetch(base);
        const body = await answer.text();
        return answer.ok && body.includes('<div id="root">');
    });

    await expect('a fresh copy has no account', async () => {
        const state = await (await fetch(`${base}/api/account`)).json();
        return state.available === true && state.registered === false && state.ready === false;
    });

    await expect('the mailbox is locked rather than empty', async () => {
        return (await fetch(`${base}/api/mailbox`)).status === 423;
    });

    await expect('the native database driver loaded', async () => {
        // It is loaded lazily, so the proof is that nothing above crashed *and* the process is
        // still answering. A missing `.node` takes the process down at the first import.
        return (await fetch(`${base}/api/health`)).ok;
    });

    console.log('\n✓ Das Archiv startet, bedient das Dashboard und ist ohne Konto gesperrt.');
} finally {
    child?.kill();
    await rm(where, { recursive: true, force: true });
}

async function expect(what, check) {
    const ok = await check().catch(() => false);
    if (!ok) {
        throw new Error(`Smoke test failed: ${what}`);
    }
    console.log(`  ✓ ${what}`);
}

/** Give it room to start: the first run migrates a schema and derives nothing yet. */
async function waitFor(url, output) {
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            if ((await fetch(url)).ok) {
                return;
            }
        } catch {
            // Not up yet.
        }
        await new Promise((resolve_) => setTimeout(resolve_, 500));
    }
    throw new Error(`Der Server ist nicht hochgekommen.\n${output.join('')}`);
}
