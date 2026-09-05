// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Hint } from '../src/components/Hint.js';
import { Info } from '../src/components/Info.js';

/**
 * Where the bubble is in the document — which is the whole bug.
 *
 * It used to be a child of its trigger, positioned absolutely. The sidebar is a scroll container,
 * so a bubble reaching past its edge grew the sidebar's scrollable area: hovering the sign-out
 * button made the navigation scrollable sideways and downwards, and the page moved under the
 * pointer that was only asking what a button does.
 *
 * Fixed positioning alone does not fix that — a fixed element still contributes to an ancestor's
 * overflow if a transformed or filtered ancestor makes it the containing block. Being in
 * `document.body` does, unconditionally, which is why that is what is asserted here rather than a
 * computed style. Layout itself is out of reach in this environment; the structure is not, and the
 * structure is the guarantee.
 */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    host.remove();
});

function hover(element: Element): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
}

describe('a hint', () => {
    it('is not in the document until it is asked for', () => {
        act(() => {
            root.render(
                <Hint text="Der Schlüssel wird noch gehalten.">
                    <button type="button">Abmelden</button>
                </Hint>
            );
        });

        expect(document.querySelector('.info-bubble')).toBeNull();
    });

    it('opens on hovering the trigger itself, with no second thing to aim at', () => {
        // The sign-out button carries its own explanation now. An `i` mark beside it meant a
        // 16-pixel target in the corner of the navigation for a sentence about the button next to
        // it.
        act(() => {
            root.render(
                <Hint text="Der Schlüssel wird noch gehalten.">
                    <button type="button">Abmelden</button>
                </Hint>
            );
        });

        const button = host.querySelector('button');
        expect(button?.textContent).toBe('Abmelden');
        hover(button as Element);

        expect(document.querySelector('.info-bubble')?.textContent).toBe(
            'Der Schlüssel wird noch gehalten.'
        );
    });

    it('renders the bubble into the body, never inside whatever it is standing in', () => {
        act(() => {
            root.render(
                <Hint text="Erklärung">
                    <button type="button">Abmelden</button>
                </Hint>
            );
        });
        hover(host.querySelector('button') as Element);

        const bubble = document.querySelector('.info-bubble');
        expect(bubble?.parentElement).toBe(document.body);
        // The important half: nothing inside the trigger's own subtree, which is what an ancestor
        // with `overflow: auto` would have had to make room for.
        expect(host.querySelector('.info-bubble')).toBeNull();
    });

    it('takes the bubble away again when the pointer leaves', () => {
        act(() => {
            root.render(
                <Hint text="Erklärung">
                    <button type="button">Abmelden</button>
                </Hint>
            );
        });
        const button = host.querySelector('button') as Element;
        hover(button);
        act(() => {
            button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });

        // Removed rather than hidden: a bubble that is merely transparent still takes clicks and is
        // still read out.
        expect(document.querySelector('.info-bubble')).toBeNull();
    });

    it('names the bubble as the description only while it is open', () => {
        act(() => {
            root.render(
                <Hint text="Erklärung">
                    <button type="button">Abmelden</button>
                </Hint>
            );
        });
        const wrapper = host.querySelector('.hint') as HTMLElement;
        expect(wrapper.getAttribute('aria-describedby')).toBeNull();

        hover(host.querySelector('button') as Element);
        expect(wrapper.getAttribute('aria-describedby')).toBe(
            document.querySelector('.info-bubble')?.id
        );
    });
});

describe('the i mark', () => {
    it('opens on a tap as well, because a phone has no hover', () => {
        act(() => {
            root.render(<Info label="Was das bedeutet">Die Begründung.</Info>);
        });

        const mark = host.querySelector('.info-mark') as HTMLElement;
        act(() => {
            mark.click();
        });

        expect(document.querySelector('.info-bubble')?.textContent).toBe('Die Begründung.');
    });

    it('puts its bubble in the body too', () => {
        act(() => {
            root.render(<Info label="Was das bedeutet">Die Begründung.</Info>);
        });
        act(() => {
            (host.querySelector('.info-mark') as HTMLElement).click();
        });

        expect(document.querySelector('.info-bubble')?.parentElement).toBe(document.body);
        expect(host.querySelector('.info-bubble')).toBeNull();
    });
});
