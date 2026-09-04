// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_RULES } from '@pms/demo';

import { RuleEditor } from '../src/components/RuleEditor.js';
import { fromRule, newDraft, type RuleDraft } from '../src/rules/draft.js';
import { Providers } from './harness.js';

/**
 * The editor, driven the way a person drives it.
 *
 * The parts worth pinning are the ones that would fail quietly. A value typed but never committed
 * must not reach the rule — otherwise the preview moves while someone is halfway through an
 * address, and worse, a half-typed value could be saved. A Sieve-authored rule must stay read-only
 * until conversion is chosen, because Proton's own interface refuses to edit one and silently
 * rewriting it here would discard whatever the script did that a tree filter cannot.
 */

let container: HTMLDivElement;
let draft: RuleDraft;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    container.remove();
});

function render(initial: RuleDraft, savedRule = undefined as Parameters<typeof RuleEditor>[0]['savedRule']): void {
    draft = initial;
    const root = createRoot(container);
    const paint = (): void => {
        root.render(
            <Providers>
                    <RuleEditor
                        draft={draft}
                        original={initial}
                        savedRule={savedRule}
                        onChange={(next) => {
                            draft = next;
                            act(() => {
                                paint();
                            });
                        }}
                        onSave={() => {}}
                        onCancel={() => {}}
                        onOpenMail={() => {}}
                    />
            </Providers>
        );
    };
    act(() => {
        paint();
    });
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
    const found = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    if (found === null) {
        throw new Error(`no control labelled ${label}`);
    }
    return found;
}

function typeInto(element: HTMLInputElement | HTMLSelectElement, value: string): void {
    act(() => {
        const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
}

/**
 * Type a value and commit it.
 *
 * Re-queries the input between the two steps: every keystroke re-renders the editor, so the element
 * captured before typing is detached by the time Enter would reach it. Holding the stale reference
 * made this look like a broken commit rather than a broken test.
 */
function enterValue(value: string): void {
    typeInto(field('Wert für diese Bedingung'), value);
    act(() => {
        field('Wert für diese Bedingung').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        );
    });
}

describe('entering a condition value', () => {
    it('does not change the rule until the value is committed', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        typeInto(field('Wert für diese Bedingung'), 'bahn');

        // Typed, not committed: it sits in `pending` and the rule is unchanged.
        expect(draft.conditions[0]?.pending).toBe('bahn');
        expect(draft.conditions[0]?.values).toEqual([]);
    });

    it('commits on Enter and shows the value as a chip', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        enterValue('bahn');

        expect(draft.conditions[0]?.values).toEqual(['bahn']);
        expect(draft.conditions[0]?.pending).toBe('');
        expect(container.textContent).toContain('bahn');
    });

    it('joins several values with „oder", because that is what they do', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        enterValue('bahn');
        enterValue('sbb');

        expect(draft.conditions[0]?.values).toEqual(['bahn', 'sbb']);
        expect(container.textContent).toContain('oder');
    });

    it('clears values when the field changes, since they rarely mean the same thing', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        enterValue('noreply@bahn.example');
        typeInto(field('Feld'), 'subject');

        expect(draft.conditions[0]?.values).toEqual([]);
    });
});

describe('the preview', () => {
    it('counts what the rule catches and updates when a value is committed', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        enterValue('bahn');

        expect(container.textContent).toMatch(/Trifft \d+ Mails?/);
        expect(container.textContent).toContain('Wird getroffen');
        expect(container.textContent).toContain('Wird nicht getroffen');
    });

    it('says the editor cannot filter on content, rather than leaving it to be guessed', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        expect(container.textContent).toContain('Auf den Inhalt einer Mail kann eine Regel nicht zugreifen');
    });
});

describe('a Sieve-authored rule', () => {
    const sieveRule = DEMO_RULES.find((rule) => rule.authoredAs === 'sieve');

    it('exists in the demo, or this test is testing nothing', () => {
        expect(sieveRule).toBeDefined();
    });

    it('is read-only until conversion is chosen', () => {
        if (sieveRule === undefined) {
            return;
        }
        render(fromRule(sieveRule), sieveRule);

        expect(container.textContent).toContain('als Sieve-Skript geschrieben');
        expect(field('Name der Regel').disabled).toBe(true);
    });

    it('offers conversion, and unlocks only after it is taken', () => {
        if (sieveRule === undefined) {
            return;
        }
        render(fromRule(sieveRule), sieveRule);

        const convert = [...container.querySelectorAll('button')].find((entry) =>
            (entry.textContent ?? '').includes('In einen Proton-Filter umwandeln')
        );
        expect(convert).toBeDefined();

        act(() => {
            convert?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(field('Name der Regel').disabled).toBe(false);
    });
});

describe('unsaved work', () => {
    it('is marked, so leaving the page is a decision', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        enterValue('bahn');

        expect(container.textContent).toContain('Nicht gespeichert');
    });

    it('refuses to stage a rule with an empty condition', () => {
        render({ ...newDraft('Archiv'), name: 'Test' });

        const save = [...container.querySelectorAll('button')].find((entry) =>
            (entry.textContent ?? '').includes('vormerken')
        );
        expect(save?.disabled).toBe(true);
    });
});
