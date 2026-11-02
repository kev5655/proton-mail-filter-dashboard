/**
 * The questions a packaged copy has to answer, wherever it has been packaged into.
 *
 * They were written for the downloadable archive, and then the container image needed the same four
 * — which is how they came to exist twice: once here and once as a dozen lines of `curl` inside a
 * workflow. Two copies of a contract drift, and the copy in the workflow is the one nobody runs
 * before pushing. So the questions live here, and `archive.mjs` and `image.mjs` are the two things
 * that know how to start something and hand over a base URL.
 *
 * What they are actually for: the bundle, the native database driver, the built dashboard and the
 * path handling only ever meet outside the workspace. Every one of them has a way to be wrong that
 * no test against the source can see — the first packaged build died on its first line because
 * `paths.ts` looked for a workspace marker above itself and threw when there was none, while every
 * test stayed green.
 *
 * **None of this reaches Proton.** A fresh directory has no account and no stored session, so the
 * server comes up locked, and being locked is the state under test.
 */

/**
 * Ask all four. Throws on the first one that fails, so the output names the thing that broke.
 *
 * `log` is injected because the archive script prints to a terminal and a test wants the lines in
 * its own output — and because a check that prints nothing is one nobody reads.
 */
export async function askTheQuestions(base, log = console.log) {
    for (const { what, check } of questions(base)) {
        const ok = await check().catch(() => false);
        if (!ok) {
            throw new Error(`Smoke test failed: ${what}`);
        }
        log(`  ✓ ${what}`);
    }
}

/** The list itself, so a caller can report on them one at a time. */
export function questions(base) {
    return [
        {
            what: 'the dashboard is served',
            check: async () => {
                const answer = await fetch(base);
                const body = await answer.text();
                return answer.ok && body.includes('<div id="root">');
            },
        },
        {
            what: 'a fresh copy has no account',
            check: async () => {
                const state = await (await fetch(`${base}/api/account`)).json();
                return state.available === true && state.registered === false && state.ready === false;
            },
        },
        {
            what: 'the mailbox is locked rather than empty',
            check: async () => (await fetch(`${base}/api/mailbox`)).status === 423,
        },
        {
            what: 'the native database driver loaded',
            check: async () =>
                // Loaded lazily, so the proof is that nothing above crashed *and* it is still
                // answering: a missing `.node` takes the process down at the first import.
                (await fetch(`${base}/api/health`)).ok,
        },
    ];
}

/**
 * Give it room to come up: the first run migrates a schema and derives nothing yet.
 *
 * `diagnostics` is called only on failure, and only then — for the image it costs a `docker logs`,
 * which is worth having in the error and not worth collecting on every attempt.
 */
export async function waitForHealth(base, diagnostics = () => '', attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            if ((await fetch(`${base}/api/health`)).ok) {
                return;
            }
        } catch {
            // Not up yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Der Server ist nicht hochgekommen.\n${await diagnostics()}`);
}

/** A port unlikely to collide with a dev server, a second smoke run, or the real thing. */
export function somePort() {
    return 5187 + Math.floor(Math.random() * 200);
}
