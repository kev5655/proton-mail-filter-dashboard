// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * These used to run against the demo mailbox, which kept its own set in memory. That was the last
 * place in the interface where a click did something different depending on which mailbox was on
 * screen, and it is gone with the demo. So the two halves are tested for what they actually are:
 * the click sends one request, and the list is drawn from the snapshot the server answers with.
 * The storage itself is asserted where it lives — `packages/sync` for the table, `packages/server`
 * for the route.
 */

let container: HTMLDivElement;
let root: Root | undefined;
let sent: Array<{ groupKey: string; hidden: boolean }>;

beforeEach(() => {
    sent = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: { body?: string }) => {
            if (url === '/api/suggestions/hidden' && init?.body !== undefined) {
                sent.push(JSON.parse(init.body) as { groupKey: string; hidden: boolean });
            }
            return Promise.resolve(new Response('{}', { status: 200 }));
        })
    );
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
});

/** Mount the page against a copy whose hidden list is exactly `hidden`. */
function render(hidden: string[] = []): void {
    act(() => {
        root?.unmount();
    });
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(
            <Providers
                withStore
                status={{
                    hiddenSuggestions: hidden.map((groupKey) => ({
                        groupKey,
                        atSeconds: 1_700_000_000,
                    })),
                }}
            >
                <TriagePage />
            </Providers>
        );
    });
}

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

/** Hide the first suggestion and report the key the server was told about. */
function hideFirst(): string {
    render();
    click(buttons('Ausblenden')[0]);
    const first = sent[0];
    if (first === undefined) {
        throw new Error('nothing was sent');
    }
    return first.groupKey;
}

describe('hiding a suggestion', () => {
    it('says „Ausblenden", not „Nicht vorschlagen"', () => {
        // The old wording described the tool's future behaviour, which it then did not have. This
        // one describes what the click does, which is all it ever did.
        render();
        expect(buttons('Ausblenden').length).toBeGreaterThan(0);
        expect(buttons('Nicht vorschlagen')).toHaveLength(0);
    });

    it('has no „Ausgeblendet" section until something is in it', () => {
        render();
        expect(headings().some((heading) => heading.includes('Ausgeblendet'))).toBe(false);
    });

    it('tells the server which group, and that it is going away', () => {
        // The click no longer changes anything locally. If it stopped sending this, every screen
        // below would still look right and the decision would be forgotten on the next reload —
        // which is the exact bug this feature exists to have fixed.
        const groupKey = hideFirst();

        expect(sent).toEqual([{ groupKey, hidden: true }]);
    });

    it('takes the card out of the list above and puts it in that section', () => {
        const groupKey = hideFirst();
        const before = buttons('Ausblenden').length;

        render([groupKey]);

        expect(buttons('Ausblenden')).toHaveLength(before - 1);
        expect(hiddenToggle()?.textContent).toContain('Ausgeblendet');
    });

    it('starts the section collapsed, because it is an archive and not a list of work', () => {
        render([hideFirst()]);

        expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('false');
        // Collapsed means the card is not rendered, so nothing offers to bring it back yet.
        expect(buttons('Wieder einblenden')).toHaveLength(0);
    });

    it('gives it back, which is the whole reason the section exists', () => {
        const groupKey = hideFirst();
        render([groupKey]);
        click(hiddenToggle());
        sent.length = 0;

        click(buttons('Wieder einblenden')[0]);

        expect(sent).toEqual([{ groupKey, hidden: false }]);
    });

    it('counts what is in there', () => {
        const first = hideFirst();
        render();
        const second = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .filter((button) => button.textContent?.trim() === 'Ausblenden')
            .at(1);
        sent.length = 0;
        click(second);
        const key = sent[0]?.groupKey;
        if (key === undefined) {
            throw new Error('nothing was sent');
        }

        render([first, key]);

        const heading = [...container.querySelectorAll('h2')].find((node) =>
            node.textContent?.includes('Ausgeblendet')
        );
        expect(heading?.textContent).toContain('(2)');
    });
});
