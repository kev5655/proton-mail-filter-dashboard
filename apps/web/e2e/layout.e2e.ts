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
 * Several widths, because the failure is width-dependent: the layout drops to two columns at 1160,
 * to one at 1100 and again at 860, and the navigation becomes a strip at 620 — each of those is a
 * different set of rules.
 */

let harness: Harness;

beforeAll(async () => {
    harness = await start();
});

afterAll(async () => {
    await harness.close();
});

const PAGES = [
    'Vorschläge',
    'Regeln',
    'Kategorien',
    'Auto-Regeln',
    'Ordner',
    'Änderungen',
    'Verlauf',
    'Einstellungen',
];
/*
 * 390 is a phone held upright and 620 is the breakpoint's own edge; both were added when the
 * navigation became a strip there, because a layout nothing measures is a layout that breaks
 * quietly. 1160 is the edge of the two-column grid.
 */
const WIDTHS = [1440, 1280, 1160, 1024, 900, 780, 620, 390];

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
        /*
         * `.nav-items` used to be on this list: on a phone it was a strip that scrolled sideways
         * on purpose. It is a field of wrapping chips now, so the exemption is gone and the
         * navigation is held to the same rule as every other element — which is the whole reason
         * for taking it off.
         */
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

/**
 * The navigation stays where it is.
 *
 * Reading down a long rule list used to carry the sidebar off the top of the screen, because the
 * *page* scrolled and both grid columns went with it. Measured rather than reasoned about: scroll
 * the content and see whether the bar moved.
 *
 * And the opposite case at 780px, which is the more interesting half. Below the breakpoint the grid
 * collapses to one column with the bar *above* the content, where pinning it would eat half a
 * narrow screen — so there it has to scroll away like anything else.
 */
describe('the navigation while the content scrolls', () => {
    async function scrollAndMeasure(width: number): Promise<{ before: number; after: number; scrolled: number }> {
        // „Vorschläge" and a short window, because the test needs something that genuinely
        // overflows — measuring whether a bar moved while nothing scrolled proves nothing.
        await harness.page.setViewportSize({ width, height: 600 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
        await harness.page.getByRole('button', { name: 'Vorschläge', exact: false }).first().click();
        await harness.page.waitForTimeout(250);

        const before = (await harness.page.locator('.sidebar').boundingBox())?.y ?? 0;

        const scrolled = await harness.page.evaluate(() => {
            const main = document.querySelector('.main');
            // Whichever of the two actually scrolls in this layout — that is the thing under test.
            const target = main !== null && main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
            target?.scrollBy(0, 400);
            return target === main ? (main?.scrollTop ?? 0) : (document.scrollingElement?.scrollTop ?? 0);
        });
        await harness.page.waitForTimeout(120);

        const after = (await harness.page.locator('.sidebar').boundingBox())?.y ?? 0;
        return { before, after, scrolled };
    }

    it('stays put on a wide screen', async () => {
        const { before, after, scrolled } = await scrollAndMeasure(1440);

        // Something has to have scrolled, or the test proves nothing about staying still.
        expect(scrolled).toBeGreaterThan(0);
        expect(after).toBe(before);
    });

    it('scrolls away with everything else on a narrow one', async () => {
        // Below 860 the bar sits above the content. Pinning it there would take a fixed slice out
        // of a screen that has none to spare.
        const { before, after, scrolled } = await scrollAndMeasure(780);

        expect(scrolled).toBeGreaterThan(0);
        expect(after).toBeLessThan(before);
    });
});

/**
 * Where connecting, syncing and locking sit.
 *
 * On a phone the bar is above the content, so anything at the end of the bar is *before* the page.
 * Three panels nobody needs on the way in therefore stood between every screen and its own first
 * line. They belong after the content there, and in the bar where the bar has its own column.
 *
 * Measured by position rather than by class, because the arrangement is done entirely in the grid:
 * the markup order is the same at both widths, which is exactly the kind of thing a reading of the
 * source would get wrong.
 */
describe('the tools panel', () => {
    async function toolsAndContent(width: number): Promise<{ tools: number; content: number }> {
        await harness.page.setViewportSize({ width, height: 800 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });
        await harness.page.waitForTimeout(200);

        const tools = (await harness.page.locator('.sidebar-tools').boundingBox())?.y ?? 0;
        const content = (await harness.page.locator('.main').boundingBox())?.y ?? 0;
        return { tools, content };
    }

    it('comes after the page on a phone', async () => {
        const { tools, content } = await toolsAndContent(390);

        expect(tools).toBeGreaterThan(content);
    });

    it('sits beside the page on a wide screen, where there is a column for it', async () => {
        const { tools, content } = await toolsAndContent(1440);

        // Same top edge region rather than below: it is in the left column, not under the content.
        const left = (await harness.page.locator('.sidebar-tools').boundingBox())?.x ?? 0;
        const mainLeft = (await harness.page.locator('.main').boundingBox())?.x ?? 0;
        expect(left).toBeLessThan(mainLeft);
        expect(tools).toBeLessThan(content + 800);
    });

    it('keeps the source banner out of the move, because that one has to be read first', async () => {
        // „Whose mailbox is this" is not a tool. Somebody looking at a plausible list of their own
        // folder names must be able to tell whether it is theirs before they read the list.
        await harness.page.setViewportSize({ width: 390, height: 800 });
        await harness.page.goto(harness.url, { waitUntil: 'networkidle' });

        const banner = (await harness.page.locator('.demo-banner').first().boundingBox())?.y ?? 0;
        const content = (await harness.page.locator('.main').boundingBox())?.y ?? 0;

        expect(banner).toBeLessThan(content);
    });
});
