// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_FOLDERS, DEMO_RULES, generateMailbox } from '@pms/demo';
import { CATEGORY_LABELS } from '@pms/grouping';

import { buildMailbox } from '../src/data.js';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';
import { MailboxProvider } from '../src/mailbox.js';
import { AppStateProvider } from '../src/state.js';

/**
 * Proton's own categories, and what the screen is allowed to claim about them.
 *
 * The derivation matters more than the rendering here, and the risky part of it is the id: nothing
 * in this repository verifies that 20–26 are Proton's categories, and every message also carries
 * system location labels ('0' inbox, '6' archive) that look exactly the same. Mistaking one for a
 * category would put the whole inbox under a heading that means nothing.
 */

const mailbox = buildMailbox({
    messages: generateMailbox(),
    folders: DEMO_FOLDERS,
    rules: DEMO_RULES,
});

describe('the derivation', () => {
    it('finds the categories the demo mailbox actually carries', () => {
        const ids = mailbox.categories.map((entry) => entry.id);

        // The demo generator assigns 21, 22, 25 and 26 to its senders.
        expect(ids).toContain('25');
        expect(ids).toContain('21');
        expect(mailbox.categories.every((entry) => entry.messages.length > 0)).toBe(true);
    });

    it('never mistakes a system location for a category', () => {
        const ids = mailbox.categories.map((entry) => entry.id);

        // '0' is the inbox and '6' the archive. Every message carries one, so treating either as a
        // category would produce a heading covering the entire mailbox.
        expect(ids).not.toContain('0');
        expect(ids).not.toContain('6');
    });

    it('uses the German names, so this screen and the suggestions agree', () => {
        const newsletter = mailbox.categories.find((entry) => entry.id === '25');

        expect(newsletter?.label).toBe(CATEGORY_LABELS['25']);
        expect(newsletter?.unknown).toBe(false);
    });

    it('counts how much of each category is still in the inbox', () => {
        for (const entry of mailbox.categories) {
            expect(entry.inInbox).toBeLessThanOrEqual(entry.messages.length);
        }
    });

    it('names the own rules that move categorised mail as well', () => {
        // The one actionable fact on the screen: Proton already sorts this, so a rule doing it too
        // is a second thing to keep in step. The demo's catch-all guarantees at least one.
        const withRules = mailbox.categories.filter((entry) => entry.alsoMovedByRules.length > 0);

        expect(withRules.length).toBeGreaterThan(0);
        for (const entry of withRules) {
            for (const rule of entry.alsoMovedByRules) {
                expect(rule.count).toBeGreaterThan(0);
                expect(rule.ruleName).not.toBe('');
            }
        }
    });
});

describe('the screen', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('renders and says that Proton does this sorting itself', () => {
        const root = createRoot(container);
        act(() => {
            root.render(
                <MailboxProvider>
                    <AppStateProvider>
                        <CategoriesPage />
                    </AppStateProvider>
                </MailboxProvider>
            );
        });

        const text = container.textContent ?? '';
        expect(text).toContain('Kategorien');
        expect(text).toContain('Proton sortiert diese Mail selbst');
        expect(text).toContain('Newsletter');
    });
});
