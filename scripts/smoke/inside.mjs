import { askTheQuestions, waitForHealth } from './checks.mjs';

/**
 * The four questions, asked from *inside* the container.
 *
 * Not a convenience. The server binds `127.0.0.1`, and inside a container that is the container's
 * own loopback — which a published port does not reach: `docker run -p` forwards to the container's
 * network interface, not to its loopback. A smoke test that published a port therefore watched the
 * server start, report itself healthy in its own logs, and answer nothing.
 *
 * The binding is right and stays. In the deployment the Tailscale sidecar **shares this network
 * namespace**, so its `serve.json` proxying to `http://127.0.0.1:5174` reaches exactly this process,
 * and nothing is exposed to the container network at all. Asking from inside is therefore not a
 * workaround — it is the only place the questions can be asked the way the sidecar asks them.
 *
 * Run by `image.mjs` through `docker exec`, with `scripts/smoke/` mounted read-only, so the
 * questions have one definition rather than a second copy written in shell.
 */

const port = process.env['PMS_SERVER_PORT'] ?? '5174';
const base = `http://127.0.0.1:${port}`;

await waitForHealth(base);
await askTheQuestions(base);

console.log('\n✓ Das Image startet, bedient das Dashboard und ist ohne Konto gesperrt.');
