import { createRequire } from 'node:module';
import { cp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import * as esbuild from 'esbuild';

/**
 * Turn the workspace into something somebody can download.
 *
 * The shape is the one the application already has — a local server plus a browser — rather than a
 * new one. There is no Electron here on purpose: the login *must* happen in the user's own browser,
 * with their password manager's extension and their passkeys, so bundling a second browser would
 * add a hundred megabytes and still not be the browser that matters.
 *
 * Three things end up in `release/app/`:
 *
 *  - `server.mjs` — the whole workspace bundled into one file. That also solves a problem the
 *    checkout has: `@protontech/crypto` and the vendored Proton packages ship raw TypeScript, which
 *    is why `pnpm serve` needs vite-node. Bundling transpiles them once, here, and the result is
 *    plain JavaScript that Node can run by itself.
 *  - `web/` — the built dashboard, served by that same process. Same origin, so the browser is
 *    never asked which origins may read one account's mailbox.
 *  - `node_modules/` — the two dependencies that cannot be bundled, installed for the platform this
 *    runs on.
 *
 * Those two are external for different reasons, and both are worth knowing. `better-sqlite3-multiple-ciphers`
 * is a native module: its `.node` binary is compiled per platform and per Node version, so it has
 * to be installed on the machine the archive is built for. `playwright` resolves its driver through
 * paths relative to its own package directory, which bundling breaks.
 *
 * **The browser is not shipped.** `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` keeps a 150 MB Chromium out of
 * the archive, and the app signs in through the browser the user already has — which is what the
 * login needs anyway: an extension cannot exist in a throwaway profile, and a passkey lives in a
 * real browser's own store.
 */

/**
 * What lands next to the launcher, for somebody who downloaded this and nothing else.
 *
 * Short on purpose. The two things that are genuinely surprising get a line each: the browser is
 * not included, and the password cannot be recovered. Everything else is on the screen.
 */
const README = `Proton Mail Sorter
==================

Starten
-------
  Linux/macOS   ./proton-mail-sorter.sh
  Windows       proton-mail-sorter.cmd

Dann im Browser oeffnen, was im Terminal steht (meist http://127.0.0.1:5174).

Beim ersten Start legst du im Dashboard ein Konto an. Dieses Passwort ist der
Schluessel fuer alles, was hier auf der Platte liegt -- die Kopie deines
Postfachs und die gespeicherte Proton-Sitzung. Es gibt keine Wiederherstellung:
ohne das Passwort ist der Ordner data/ unlesbar, auch fuer dich.

Fuer die Anmeldung bei Proton brauchst du Chrome oder Edge auf diesem Rechner.
Ein Browser ist absichtlich nicht mitgeliefert: die Anmeldung laeuft in deinem
eigenen Browser, damit dein Passwort-Manager das Formular ausfuellen kann und
ein Passkey seinen Speicher findet. Dieses Programm sieht dein Proton-Passwort
nie.

Alles bleibt hier
-----------------
Der Server hoert nur auf 127.0.0.1. Alles, was das Programm behaelt, liegt in
data/ neben dieser Datei -- loeschen genuegt, und es ist weg. Ausnahme: wenn du
in den Einstellungen ein Cloud-Sprachmodell einschaltest, verlassen Betreffe und
Absender diesen Rechner; das steht dort auch so.

Lizenz: GPL-3.0. Enthaelt Code von ProtonMail/WebClients (GPL-3.0).
`;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'release');
const APP = join(OUT, 'app');

/**
 * `openpgp/lightweight` is a browser-only entry point that Proton's crypto package imports
 * unconditionally, so under Node it resolves to nothing. The same redirect is in `vite.config.ts`,
 * with the longer explanation; without it there is no SRP login at all.
 *
 * Resolved from a package that actually depends on it, because pnpm does not put it at the root.
 */
const requireFromApi = createRequire(join(ROOT, 'packages', 'proton-api', 'package.json'));
const openpgpNodeEntry = join(dirname(requireFromApi.resolve('@protontech/openpgp')), 'openpgp.mjs');

const openpgpForNode = {
    name: 'openpgp-node',
    setup(build) {
        build.onResolve({ filter: /^openpgp\/lightweight$/ }, () => ({ path: openpgpNodeEntry }));
    },
};

/** Not bundled, and each for its own reason — see the note at the top of this file. */
const EXTERNAL = ['better-sqlite3-multiple-ciphers', 'playwright'];

function run(command, args, cwd = ROOT) {
    execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

function versionOf(name) {
    const manifest = JSON.parse(
        execFileSync('node', ['-e', `console.log(JSON.stringify(require('${name}/package.json')))`], {
            cwd: join(ROOT, name === 'playwright' ? 'packages/browser-auth' : 'packages/store'),
            encoding: 'utf8',
        })
    );
    return manifest.version;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(APP, { recursive: true });

console.log('· Vendored Proton declarations');
run('pnpm', ['build:vendor']);

console.log('· Dashboard');
run('pnpm', ['--filter', '@pms/web', 'build']);
await cp(join(ROOT, 'apps', 'web', 'dist'), join(APP, 'web'), { recursive: true });

console.log('· Server bundle');
await esbuild.build({
    entryPoints: [join(ROOT, 'apps', 'spike', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile: join(APP, 'server.mjs'),
    external: EXTERNAL,
    plugins: [openpgpForNode],
    // Some bundled dependencies are CommonJS and call `require` at runtime; ESM has none.
    banner: {
        js: "import{createRequire as __pmsRequire}from'node:module';const require=__pmsRequire(import.meta.url);",
    },
    logLevel: 'warning',
});

console.log('· Native and driver dependencies');
await writeFile(
    join(APP, 'package.json'),
    `${JSON.stringify(
        {
            name: 'proton-mail-sorter',
            version: JSON.parse(
                await import('node:fs/promises').then((fs) =>
                    fs.readFile(join(ROOT, 'package.json'), 'utf8')
                )
            ).version,
            private: true,
            type: 'module',
            dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, versionOf(name)])),
        },
        null,
        2
    )}\n`
);

// npm rather than pnpm: the archive needs a real directory tree, not a store full of symlinks that
// break the moment it is copied to another machine.
run(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=hoisted'],
    APP
);

console.log('· Launchers');
/*
 * The launchers prefer the Node that travels with the archive.
 *
 * The release ships one — the whole point is a download that runs — but the script still falls back
 * to a Node on the PATH, so the same layout works when it is built without one. `PMS_NODE` wins over
 * both, for anyone who wants to say which.
 */
await writeFile(
    join(OUT, 'proton-mail-sorter.sh'),
    `#!/bin/sh
# Starts the local server and serves the dashboard. Everything stays on this machine.
here=$(cd "$(dirname "$0")" && pwd)
node_bin="\${PMS_NODE:-}"
if [ -z "$node_bin" ] && [ -x "$here/node/bin/node" ]; then
  node_bin="$here/node/bin/node"
fi
[ -z "$node_bin" ] && node_bin=node
exec "$node_bin" "$here/app/server.mjs" --serve "$@"
`
);
await chmod(join(OUT, 'proton-mail-sorter.sh'), 0o755);

await writeFile(
    join(OUT, 'proton-mail-sorter.cmd'),
    `@echo off
rem Starts the local server and serves the dashboard. Everything stays on this machine.
setlocal
set "HERE=%~dp0"
if "%PMS_NODE%"=="" if exist "%HERE%node\\node.exe" set "PMS_NODE=%HERE%node\\node.exe"
if "%PMS_NODE%"=="" set "PMS_NODE=node"
"%PMS_NODE%" "%HERE%app\\server.mjs" --serve %*
`
);

await cp(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'), { force: true }).catch(() => undefined);

await writeFile(join(OUT, 'LIESMICH.txt'), README);

console.log(`\nFertig: ${OUT}`);
