// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TriagePage } from '../src/pages/TriagePage.js';
import { Providers } from './harness.js';

/**
 * Finding one suggestion among dozens.
 *
 * The page groups by *how* a group was found — sender, subject, organisation — which is the right
 * grouping for deciding what kind of rule to write and the wrong one for finding a particular
 * shop's mail: that means reading all three sections. One filter over the whole page answers it,
 * and each heading then says how much of it survived, so a section that fell to nothing is visibly
 * empty rather than silently gone.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <Providers withStore>
                <TriagePage />
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

function type(value: string): void {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (input === null) {
        throw new Error('no filter field');
    }
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function sectionToggles(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button.section-toggle')];
}

describe('filtering the suggestions', () => {
    it('offers one field for the whole page', () => {
        const input = container.querySelector<HTMLInputElement>('input[type="search"]');
        expect(input?.getAttribute('aria-label')).toBe('Vorschläge filtern');
    });

    it('narrows every section at once and says by how much', () => {
        const before = container.textContent ?? '';
        expect(before).toContain('versandhaus');

        type('bahn');

        const after = container.textContent ?? '';
        expect(after).toContain('von');
        expect(after).not.toContain('versandhaus');
    });

    it('says nothing matched, and what it looked in', () => {
        type('zzz-gibt-es-nicht');

        const body = container.textContent ?? '';
        expect(body).toContain('Kein Vorschlag passt');
        // The honest half: there is no content search, because there are no mail bodies yet.
        expect(body).toContain('nicht im Mailinhalt');
    });
});

describe('collapsing a section', () => {
    it('starts open, because showing what there is comes first', () => {
        expect(sectionToggles().length).toBeGreaterThan(0);
        expect(sectionToggles()[0]?.getAttribute('aria-expanded')).toBe('true');
    });

    it('folds the section away and leaves the heading', () => {
        const toggle = sectionToggles()[0];
        const label = toggle?.textContent ?? '';

        act(() => {
            toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(sectionToggles()[0]?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain(label.replace('▾ ', '').trim());
    });
});
