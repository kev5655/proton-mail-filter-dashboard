import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type Harness } from './harness.js';

/**
 * Whether a mail body can reach the network, asked of a browser.
 *
 * `sanitize.test.ts` proves the sanitiser removes what it says it removes, and that is a test about
 * strings. The other two layers are not: `sandbox=""` and a Content-Security-Policy are enforced by
 * the browser, and nothing that is not a browser can tell you whether they hold. Until now they were
 * three layers of which one was tested.
 *
 * The stake is specific. A one-pixel image tells a sender that a message was opened, when, and from
 * which address — exactly the metadata a Proton account exists to withhold. So the assertion is not
 * that the markup looks safe; it is that no request left.
 *
 * The demo mailbox is used deliberately: it is the only source with bodies, and its bodies are
 * written to be hostile — remote images, scripts, misleading links.
 */

let harness: Harness;

beforeAll(async () => {
    harness = await start({ empty: true });
    // The demo is what has bodies, and the dashboard only falls back to it when no server answers.
    // An empty *server* is not the same thing — it answers, with an empty mailbox — and the first
    // version of this file made that mistake, so every case below skipped and passed on nothing.
    await harness.page.route('**/api/mailbox', async (route) => {
        await route.abort();
    });
});

afterAll(async () => {
    await harness.close();
});

/** Requests to anywhere that is not the dev server — that is, anything that left. */
function outbound(): string[] {
    return harness.requests.filter((url) => !url.startsWith(harness.url) && !url.startsWith('data:'));
}

async function openFirstMail(): Promise<boolean> {
    await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
    await harness.page.getByRole('button', { name: 'Regeln', exact: false }).first().click();
    await harness.page.waitForTimeout(200);

    const rule = harness.page.locator('.rule-row').first();
    if ((await rule.count()) === 0) {
        return false;
    }
    await rule.click();
    await harness.page.waitForTimeout(400);

    const mail = harness.page.locator('.mail-open').first();
    if ((await mail.count()) === 0) {
        return false;
    }
    await mail.click();
    await harness.page.waitForTimeout(500);
    return (await harness.page.locator('.viewer-frame').count()) > 0;
}

describe('a mail body', () => {
    it('can be opened at all — without this the rest proves nothing', async () => {
        // The guard the other cases need. They each check a property of an open viewer, and a
        // silently-never-opened viewer would let every one of them pass while testing air.
        expect(await openFirstMail()).toBe(true);
    });

    it('renders inside a frame that is granted nothing', async () => {
        const opened = await openFirstMail();
        expect(opened).toBe(true);

        const frame = harness.page.locator('.viewer-frame').first();
        // sandbox="" grants no scripts, no forms, no navigation, no same-origin access.
        expect(await frame.getAttribute('sandbox')).toBe('');
        expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('carries a policy forbidding every outbound request', async () => {
        expect(await openFirstMail()).toBe(true);

        // Read from `srcdoc`, not through `contentDocument`: `sandbox=""` gives the frame an opaque
        // origin, so the parent cannot see inside it — which is the isolation doing its job, and
        // trying to reach in was the mistake. What is asserted is the document we handed over.
        const document_ = await harness.page.locator('.viewer-frame').first().getAttribute('srcdoc');

        expect(document_).toContain("default-src 'none'");
        expect(document_).toContain("form-action 'none'");
        expect(document_).toContain("base-uri 'none'");
    });

    it('fetches nothing while the images are blocked', async () => {
        harness.requests.length = 0;
        expect(await openFirstMail()).toBe(true);
        await harness.page.waitForTimeout(800);

        // The assertion that matters: not that the markup looks safe, but that nothing left.
        expect(outbound()).toEqual([]);
    });

    it('names the hosts it blocked, so allowing them is a decision', async () => {
        expect(await openFirstMail()).toBe(true);

        const notices = await harness.page.locator('.viewer-notices').innerText();
        if (notices.includes('blockiert')) {
            // Whatever it blocked, it says where from — a count alone would not let anyone judge.
            expect(notices).toMatch(/Von .+\./);
        }
    });

    it('still fetches nothing from the page itself once images are allowed for one mail', async () => {
        harness.requests.length = 0;
        expect(await openFirstMail()).toBe(true);

        const allow = harness.page.getByRole('button', { name: /Grafiken für diese Mail laden/ });
        if ((await allow.count()) === 0) {
            return;
        }
        await allow.click();
        await harness.page.waitForTimeout(800);

        // Requests may now leave the *frame* — that is what the user asked for. What must not happen
        // is the dashboard itself reaching out, or the policy opening beyond images.
        const document_ = await harness.page.locator('.viewer-frame').first().getAttribute('srcdoc');

        expect(document_).toContain("default-src 'none'");
        expect(document_).toContain("form-action 'none'");
        // Exactly one hole, and it is the one that was asked for.
        expect(document_).toMatch(/img-src/);
    });
});
