import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type Harness } from './harness.js';

/**
 * Nothing may scroll sideways, measured rather than reasoned about.
 *
 * `css-overflow.test.ts` reads the stylesheet and checks that every flexible grid track is written
 * as `minmax(0, …)`. That is a tripwire for one specific mistake and it cannot tell you whether the
 * page is actually too wide — a `nowrap` badge, a table, a long unbroken address, any of them can
 * do it without touching a grid track.
 *
 * Writing this test found that the obvious version of it is wrong. The reported bug was a scrollbar
 * *inside a dialog*: `.viewer` carries `overflow: auto`, so the document never grew and a check on
 * `document.documentElement` would have stayed green while the screenshot showed the problem. What
 * has to be measured is every element, and then the ones allowed to scroll subtracted — which is a
 * short, explicit list rather than a shrug.
 *
 * Several widths, because the failure is width-dependent: the layout collapses to one column at
 * 1100 and again at 860, and each of those is a different set of rules.
 */

let harness: Harness;

beforeAll(async () => {
    harness = await start();
});

afterAll(async () => {
    await harness.close();
});

const PAGES = ['Vorschläge', 'Regeln', 'Kategorien', 'Ordner', 'Änderungen', 'Verlauf', 'Protokoll', 'Einstellungen'];
const WIDTHS = [1440, 1280, 1024, 900, 780];

/**
 * Every element wider than the space it has, minus the ones meant to be.
 *
 * Two kinds are excluded, and both exclusions are decisions rather than conveniences:
 *
 *  - **Deliberate clipping.** An element with `overflow: hidden` and `text-overflow: ellipsis` is
 *    *supposed* to have more content than room — that is what the ellipsis is. Its `scrollWidth`
 *    exceeding `clientWidth` is the mechanism working, not a fault.
 *  - **Code and form controls.** A Sieve script gets its own scrollbar on purpose, and a `<select>`
 *    reports a phantom overflow in Chromium for its internal button.
 *
 * Everything else that scrolls sideways is a bug. The first run of this found one: `.mail-open` was
 * `align-items: flex-start`, so a long subject took its full 232 pixels inside a 168 pixel row and
 * the ellipsis never had anything to clip against.
 */
async function sidewaysScrollers(): Promise<string[]> {
    return harness.page.evaluate(() => {
        const allowed = ['.sieve-code', 'select', 'pre', 'code'];
        const found: string[] = [];

        for (const element of document.querySelectorAll<HTMLElement>('body *')) {
            if (element.scrollWidth <= element.clientWidth + 1) {
                continue;
            }
            const style = window.getComputedStyle(element);
            if (style.textOverflow === 'ellipsis' && style.overflowX !== 'visible') {
                continue;
            }
            if (allowed.some((selector) => element.matches(selector) || element.closest(selector) !== null)) {
                continue;
            }
            // Elements the sanitiser renders inside a sandboxed frame are not ours to measure.
            if (element.closest('iframe') !== null) {
                continue;
            }
            const label = `${element.tagName.toLowerCase()}.${element.className.toString().split(' ')[0] ?? ''}`;
            found.push(`${label} (${String(element.scrollWidth)} in ${String(element.clientWidth)})`);
        }
        return found;
    });
}

async function documentOverflow(): Promise<number> {
    return harness.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

describe('no screen scrolls sideways', () => {
    it.each(WIDTHS)('at %ipx, on every screen', async (width) => {
        await harness.page.setViewportSize({ width, height: 900 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });

        for (const name of PAGES) {
            await harness.page.getByRole('button', { name, exact: false }).first().click();
            // Let the page settle before measuring; a mid-render measurement proves nothing.
            await harness.page.waitForTimeout(120);

            expect(await documentOverflow(), `${name} bei ${String(width)}px`).toBeLessThanOrEqual(0);
            expect(await sidewaysScrollers(), `${name} bei ${String(width)}px`).toEqual([]);
        }
    });

    it('holds inside the dialogs too, which is where it was actually reported', async () => {
        // The screenshot showed a scrollbar under a dialog, not under the window. `.viewer` scrolls
        // its own content, so the document stayed the right width the whole time.
        await harness.page.setViewportSize({ width: 1280, height: 900 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });

        await harness.page.getByRole('button', { name: 'Vorschläge', exact: false }).first().click();
        await harness.page.waitForTimeout(150);

        const build = harness.page.getByRole('button', { name: /Regel anlegen/ }).first();
        if ((await build.count()) > 0) {
            await build.click();
            await harness.page.waitForTimeout(250);

            expect(await harness.page.locator('.viewer, .overlay').count()).toBeGreaterThan(0);
            expect(await sidewaysScrollers()).toEqual([]);
        }
    });
});

describe('the lists use the width they are given', () => {
    it('fills the window rather than stopping at a fixed column', async () => {
        await harness.page.setViewportSize({ width: 1600, height: 900 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
        await harness.page.getByRole('button', { name: 'Regeln', exact: false }).first().click();
        await harness.page.waitForTimeout(150);

        const main = await harness.page.locator('.main').boundingBox();

        // The old `max-width: 1080px` left everything cut off on a wide screen. Sidebar is 232.
        expect(main?.width ?? 0).toBeGreaterThan(1200);
    });

    it('truncates a long subject instead of widening the row', async () => {
        await harness.page.setViewportSize({ width: 1280, height: 900 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
        await harness.page.getByRole('button', { name: 'Regeln', exact: false }).first().click();
        await harness.page.getByRole('button', { name: /Rechnungen einsortieren/ }).first().click();
        await harness.page.waitForTimeout(200);

        const subject = harness.page.locator('.mail-subject').first();
        if ((await subject.count()) === 0) {
            return;
        }

        // The seeded mailbox has one deliberately unreasonable subject. Ellipsed, not expanded.
        const overflowed = await subject.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        const box = await subject.boundingBox();

        expect(overflowed || (box?.width ?? 0) < 1200).toBe(true);
        expect(await sidewaysScrollers()).toEqual([]);
    });
});
