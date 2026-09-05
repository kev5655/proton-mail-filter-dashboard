// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TriagePage } from '../src/pages/TriagePage.js';
import { Providers } from './harness.js';

/**
 * Putting a suggestion away, and getting it back.
 *
 * „Nicht vorschlagen" used to be a `useState` and nothing else, so the decision lasted until the
 * page was reloaded and then every dismissed suggestion returned. The button meant „until you look
 * away", which is neither what it said nor what anybody wanted — and the way to notice was to come
 * back the next day.
 *
 * These run against the demo mailbox, which keeps its own set in memory because it has no database
 * to write to. That is the point of the demo: the same screen, the same buttons, and no way for a
 * reader to tell which mailbox they are looking at. The persistence itself is asserted where it
 * lives — `packages/sync` for the table, `packages/server` for the route.
 */

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(
            <Providers withStore>
                <TriagePage />
            </Providers>
        );
    });
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
});

function buttons(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
        (button) => button.textContent?.trim() === label
    );
}

function click(element: HTMLElement | undefined): void {
    if (element === undefined) {
        throw new Error('nothing to click');
    }
    act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

function headings(): string[] {
    return [...container.querySelectorAll('h2')].map((heading) => heading.textContent?.trim() ?? '');
}

function hiddenToggle(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button.section-toggle')].find((button) =>
        button.textContent?.includes('Ausgeblendet')
    );
}

describe('hiding a suggestion', () => {
    it('says „Ausblenden", not „Nicht vorschlagen"', () => {
        // The old wording described the tool's future behaviour, which it then did not have. This
        // one describes what the click does, which is all it ever did.
        expect(buttons('Ausblenden').length).toBeGreaterThan(0);
        expect(buttons('Nicht vorschlagen')).toHaveLength(0);
    });

    it('has no „Ausgeblendet" section until something is in it', () => {
        expect(headings().some((heading) => heading.includes('Ausgeblendet'))).toBe(false);
    });

    it('takes the card out of the list above and puts it in that section', () => {
        const before = buttons('Ausblenden').length;

        click(buttons('Ausblenden')[0]);

        expect(buttons('Ausblenden')).toHaveLength(before - 1);
        expect(hiddenToggle()?.textContent).toContain('Ausgeblendet');
    });

    it('starts the section collapsed, because it is an archive and not a list of work', () => {
        click(buttons('Ausblenden')[0]);

        expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('false');
        // Collapsed means the card is not rendered, so nothing offers to bring it back yet.
        expect(buttons('Wieder einblenden')).toHaveLength(0);
    });

    it('gives it back, which is the whole reason the section exists', () => {
        const before = buttons('Ausblenden').length;
        click(buttons('Ausblenden')[0]);
        click(hiddenToggle());

        click(buttons('Wieder einblenden')[0]);

        expect(buttons('Ausblenden')).toHaveLength(before);
        expect(headings().some((heading) => heading.includes('Ausgeblendet'))).toBe(false);
    });

    it('counts what is in there', () => {
        click(buttons('Ausblenden')[0]);
        click(buttons('Ausblenden')[0]);

        const heading = [...container.querySelectorAll('h2')].find((node) =>
            node.textContent?.includes('Ausgeblendet')
        );
        expect(heading?.textContent).toContain('(2)');
    });
});
