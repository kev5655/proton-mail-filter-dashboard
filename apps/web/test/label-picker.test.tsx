// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_LABELS } from '@pms/demo';

import { LabelPicker } from '../src/components/LabelPicker.js';
import { DEFAULTS } from '../src/settings.js';
import { Providers } from './harness.js';

/**
 * Choosing a label, and what the model is allowed to do about it.
 *
 * The rule: choose from what exists; invent only when nothing fits, and only when asked. A model
 * told to "suggest labels" invents one every time, and a mailbox grows a dozen near-synonyms, each
 * with its own rule. So the account's own labels are the primary interface and the model is a
 * shortcut through them — never the other way round.
 */

let container: HTMLDivElement;
let root: Root;
let picked: string[];

async function mount(): Promise<void> {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    picked = [];
    await act(async () => {
        root.render(
            <Providers>
                <LabelPicker
                    labels={DEMO_LABELS}
                    value=""
                    subjects={['Rechnung März']}
                    senders={['buchhaltung@firma.example']}
                    onPick={(name) => picked.push(name)}
                />
            </Providers>
        );
    });
    // The availability probe is a promise, so the first paint says „wird geprüft". Letting it
    // settle is the difference between testing the screen and testing its loading state.
    await act(async () => {
        await Promise.resolve();
    });
}

beforeEach(() => {
    window.localStorage.clear();
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    window.localStorage.clear();
});

function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((entry) =>
        (entry.textContent ?? '').includes(label)
    );
}

describe('without a model', () => {
    beforeEach(async () => {
        await mount();
    });

    it('still offers every label the account has', () => {
        // The list is the interface. A model is a convenience on top of it, not the way in.
        for (const label of DEMO_LABELS) {
            expect(button(label.Name), label.Name).toBeDefined();
        }
    });

    it('picks the one that was clicked', () => {
        act(() => {
            button('Steuerrelevant')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(picked).toEqual(['Steuerrelevant']);
    });

    it('says where to turn a model on', () => {
        expect(container.textContent).toContain('Kein Sprachmodell eingerichtet');
        expect(button('Einrichten')).toBeDefined();
    });
});

describe('with a model', () => {
    beforeEach(async () => {
        // A hosted model, configured but never called: `isAvailable` for that mode is a check of
        // the configuration rather than a request, so the screen can be rendered in its
        // model-is-there state without a network or a stand-in provider.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({
                ...DEFAULTS,
                llm: {
                    ...DEFAULTS.llm,
                    mode: 'cloud',
                    cloud: { provider: 'openai', apiKey: 'k', model: 'gpt-4o-mini', baseUrl: '' },
                },
            })
        );
        await mount();
    });

    it('does not let it invent by default', () => {
        // Inventing is opt-in, per checkbox, because a label is a thing that will still be in the
        // mailbox in a year.
        const allowNew = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(allowNew?.checked).toBe(false);
        expect(container.textContent).toContain('Darf ein neues Label vorschlagen, wenn keines passt');
    });

    it('says what leaves the machine, and what the model does not decide', () => {
        const text = container.textContent ?? '';
        expect(text).toContain('keine Mailinhalte');
        expect(text).toContain('es entscheidet nicht, was die Regel trifft');
    });
});
