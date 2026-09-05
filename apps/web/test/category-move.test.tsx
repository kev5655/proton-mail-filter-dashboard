// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateMailbox } from '@pms/demo';

import { CategoryMoveDialog } from '../src/components/CategoryMoveDialog.js';
import { Providers } from './harness.js';

/**
 * The only screen in the dashboard that asks for mail to be moved.
 *
 * Its failure mode is not a broken button. It is a screen that reads as settled — that offers
 * „Werbung" as though the consequence were known, when two things about it have never been watched
 * happen: whether the previous category falls away, and whether Proton then sorts future mail from
 * that sender the same way. The second is the premise of the entire feature. Most of what follows
 * checks that both are on the screen and that nothing moves before a category is picked.
 */

const selection = generateMailbox().slice(0, 3);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <Providers withStore>
                <CategoryMoveDialog selection={selection} onClose={() => undefined} />
            </Providers>
        );
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
});

function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((element) =>
        (element.textContent ?? '').includes(label)
    );
}

describe('offering a category move', () => {
    it('offers Protons categories and nothing else', () => {
        for (const label of ['Standard', 'Newsletter', 'Werbung', 'Transaktionen', 'Aktualisierungen', 'Soziale Medien']) {
            expect(button(label), label).toBeDefined();
        }
    });

    it('will not stage anything until a category is chosen', () => {
        // There is no default. A pre-selected category on the one screen that moves mail is a
        // screen that moves mail by being clicked through.
        expect(button('Kategorie wählen')?.disabled).toBe(true);
    });

    it('names both open questions before anything is offered', () => {
        const text = container.textContent ?? '';

        expect(text).toContain('Zwei Dinge sind ungeprüft');
        // The premise of the whole feature, stated as an expectation rather than a result.
        expect(text).toContain('künftige Mail dieser Absender gleich');
        expect(text).toContain('mehrere Synchronisationen');
    });

    it('says the move is limited to the selection, in the sentence itself', () => {
        // The narrowness is the reason this exception is allowed to exist, so it belongs on the
        // screen rather than only in the code that enforces it.
        expect(container.textContent).toContain('und keine weiteren');
    });

    it('names the category, not the id, on the button that stages it', () => {
        act(() => {
            button('Transaktionen')?.click();
        });

        expect(button('Nach „Transaktionen" vormerken')?.disabled).toBe(false);
    });
});
