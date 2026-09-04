import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type Harness } from './harness.js';

/**
 * The dashboard talking to a real server through the real dev proxy.
 *
 * Every check of the server so far went through `curl`, straight at its port. That says nothing
 * about whether the browser reaches it: the proxy is configuration, `EventSource` is a different
 * transport from `fetch`, and proxies are notorious for buffering a stream until it ends — which
 * would turn a progress bar into a single jump at the finish.
 *
 * The write path is here for the reason it exists at all: clicking "save" must produce an *offer*,
 * and the account must be untouched until something outside the browser agrees. The harness stands
 * in for the terminal, so both answers can be exercised.
 */

let harness: Harness;

beforeAll(async () => {
    harness = await start();
});

afterAll(async () => {
    await harness.close();
});

async function open(page = ''): Promise<void> {
    await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
    if (page !== '') {
        await harness.page.getByRole('button', { name: page, exact: false }).first().click();
        await harness.page.waitForTimeout(200);
    }
}

describe('the browser reaches the server', () => {
    it('shows the real mailbox rather than falling back to the demo', async () => {
        await open();

        // The banner is the honesty check: it names which mailbox is on screen.
        await expect
            .poll(async () => harness.page.locator('.demo-banner').innerText(), { timeout: 10_000 })
            .toContain('Echtes Postfach');
    });

    it('renders the seeded rule, so the data really came through the proxy', async () => {
        await open('Regeln');

        expect(await harness.page.locator('.rule-list').innerText()).toContain('Rechnungen einsortieren');
    });

    it('falls back to the demo, and says so, when no server answers', async () => {
        // Nobody has to run a server to look at the demo, so a refused connection is an ordinary
        // state and must read as one — not as an error, and not as a blank page.
        const solo = await start({ empty: true });
        try {
            await solo.page.route('**/api/mailbox', async (route) => {
                await route.abort();
            });
            await solo.page.goto(solo.url, { waitUntil: 'networkidle' });

            await expect
                .poll(async () => solo.page.locator('.demo-banner').innerText(), { timeout: 10_000 })
                .toContain('Demo-Daten');
        } finally {
            await solo.close();
        }
    });
});

describe('the sync stream', () => {
    it('arrives progressively rather than in one lump at the end', async () => {
        await open();

        const button = harness.page.getByRole('button', { name: 'Jetzt synchronisieren' });
        await expect.poll(async () => button.isEnabled(), { timeout: 10_000 }).toBe(true);

        // Collect what the bar says while it runs. A buffered stream would show nothing until the
        // very end, which is the failure this test exists for — proxies buffer by default.
        const seen = new Set<string>();
        const watching = (async () => {
            for (let tick = 0; tick < 60; tick++) {
                const text = await harness.page.locator('.sync-panel').innerText().catch(() => '');
                if (text.includes('Ordner und Labels')) {
                    seen.add('labels');
                }
                if (/Mails: \d+/.test(text)) {
                    seen.add('messages');
                }
                if (text.includes('geholt')) {
                    seen.add('done');
                }
                await harness.page.waitForTimeout(40);
            }
        })();

        await button.click();
        await watching;

        expect([...seen].sort()).toContain('done');
        // At least one intermediate state was visible, which is the whole point of streaming.
        expect(seen.size).toBeGreaterThan(1);
    });
});

describe('saving a rule', () => {
    /** `value` decides how much mail the rule catches, and therefore whether it is asked about. */
    async function stageARule(value = 'absender0@'): Promise<void> {
        await open('Regeln');
        await harness.page.getByRole('button', { name: 'Neue Regel' }).click();
        await harness.page.getByLabel('Name der Regel').fill('E2E-Regel');
        await harness.page.getByLabel('Wert für diese Bedingung').fill(value);
        await harness.page.getByLabel('Wert für diese Bedingung').press('Enter');
        // A *different* folder from the one the seeded filter uses, or the destination does not
        // change and the plan is empty — which is correct behaviour and a useless test.
        await harness.page.getByLabel('Zielordner').fill('Junk');
        await harness.page.waitForTimeout(300);
        await harness.page.getByRole('button', { name: /vormerken/ }).click();
        await harness.page.waitForTimeout(300);
    }

    it('goes through on the dialog’s confirmation alone, for a rule this small', async () => {
        /*
         * The case that failed in real use.
         *
         * Creating one ordinary rule was rejected with APPLY_STATE_STALE and no terminal question
         * was ever answerable — a guard that refuses everything is not a guard. Two things were
         * wrong: a mailbox copy made before the fingerprint existed could never match, and every
         * change, however small, waited on a second confirmation nobody had been told about.
         *
         * So this asserts the ordinary path end to end: click, and it is saved. No terminal.
         */
        harness.resetWrites();
        await stageARule();

        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        // The dialog closes itself when the change lands, so the assertion is on the banner that
        // outlives it — which is also the thing a user sees a minute later.
        await expect
            .poll(async () => harness.page.locator('.apply-result').innerText(), { timeout: 20_000 })
            .toContain('Bei Proton gespeichert');

        expect(harness.confirmations).toEqual([]);
        expect(harness.protonWrites()).toEqual(['POST mail/v4/filters']);
    });

    it('never reports a stale account for a copy that was just synced', async () => {
        // The exact error that made every change impossible. On a fresh mirror the change goes
        // through instead — asserting on the success is stronger than asserting on the absence of
        // one particular error message, which a different failure would satisfy just as well.
        harness.resetWrites();
        await stageARule('absender1@');
        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        await expect
            .poll(async () => harness.page.locator('.apply-result').innerText(), { timeout: 20_000 })
            .toContain('Bei Proton gespeichert');
    });

    it('shows the diff before anything is offered', async () => {
        await stageARule();

        const dialog = harness.page.locator('.viewer').first();
        expect(await dialog.innerText()).toContain('Was sich ändert');
        // Staging alone must not have asked anybody anything.
        expect(harness.confirmations).toEqual([]);
    });

    it('waits for the terminal when the change is big enough to deserve it', async () => {
        harness.resetWrites();
        harness.setConfirmAnswer('declined');
        // A rule matching every message: far past the share that earns a second question.
        await stageARule('@');

        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        // The refusal comes back through the poll, so the dialog reports it rather than hanging.
        await expect
            .poll(async () => harness.page.locator('.viewer').innerText(), { timeout: 20_000 })
            .toContain('Nicht geschrieben');

        expect(harness.confirmations.at(-1)?.answer).toBe('declined');
        expect(harness.protonWrites()).toEqual([]);
    });

    it('writes a big change only after the terminal agrees', async () => {
        harness.resetWrites();
        harness.setConfirmAnswer('granted');
        await stageARule('@');

        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        await expect
            .poll(async () => harness.page.locator('.apply-result').innerText(), { timeout: 20_000 })
            .toContain('Bei Proton gespeichert');

        expect(harness.protonWrites()).toEqual(['POST mail/v4/filters']);
    });
});

describe('the log page', () => {
    it('does not take the application down with it', async () => {
        // It used to: a snapshot that changed identity every call made React loop and throw, and
        // with no boundary the whole root unmounted. The sidebar surviving is the assertion.
        await open('Protokoll');

        expect(await harness.page.locator('.sidebar').count()).toBe(1);
        expect(await harness.page.locator('.main').innerText()).toContain('Protokoll');

        // And it is still possible to leave, which was the part that made it unrecoverable.
        await harness.page.getByRole('button', { name: 'Regeln', exact: false }).first().click();
        await harness.page.waitForTimeout(200);
        expect(await harness.page.locator('.main').innerText()).toContain('Regeln');
    });
});

describe('creating a folder', () => {
    /*
     * The screen half of the change that reported success and did nothing.
     *
     * `create-folder` reached the write path, fell through a `switch` that only knew about rules,
     * and came back applied — the dashboard said "bei Proton gespeichert" and the account never
     * heard of the folder. That half is nailed down in `apply.test.ts`, which counts the requests
     * the real path makes; the harness here has its own Proton and cannot speak to it.
     *
     * What this covers is the rest: that the folder screen stages a `create-folder` at all, that it
     * is offered rather than applied in the browser, and that the dialog leaves when the change
     * lands — it used to sit on a success message until somebody found the close button.
     */
    it('offers one, and closes the dialog when it lands', async () => {
        harness.resetWrites();
        await open('Ordner');

        await harness.page.getByPlaceholder('Neuer Ordner').fill('E2E-Ordner');
        await harness.page.getByRole('button', { name: 'Anlegen', exact: true }).click();
        await harness.page.waitForTimeout(300);

        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        await expect
            .poll(async () => harness.page.locator('.apply-result').innerText(), { timeout: 20_000 })
            .toContain('Bei Proton gespeichert');

        expect(harness.protonWrites()).toEqual(['POST core/v4/labels']);
        // The dialog is gone, so the folder list behind it is what you are looking at.
        await expect.poll(async () => harness.page.locator('.overlay').count(), { timeout: 10_000 }).toBe(0);
    });

    it('asks in the terminal before deleting one, and writes nothing when refused', async () => {
        harness.resetWrites();
        harness.setConfirmAnswer('declined');
        await open('Ordner');

        await harness.page
            .getByRole('button', { name: 'Löschen', exact: true })
            .first()
            .click();
        await harness.page.waitForTimeout(300);
        await harness.page.getByRole('button', { name: /Bei Proton speichern/ }).click();

        await expect
            .poll(async () => harness.page.locator('.viewer').innerText(), { timeout: 20_000 })
            .toContain('Nicht geschrieben');

        expect(harness.confirmations.at(-1)?.answer).toBe('declined');
        expect(harness.protonWrites()).toEqual([]);
        harness.setConfirmAnswer('granted');
    });
});
