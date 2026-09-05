// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEMO_FOLDERS, DEMO_RULES, generateMailbox } from '@pms/demo';
import { CATEGORY_LABELS } from '@pms/grouping';

import { buildMailbox } from '../src/data.js';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';
import { Providers } from './harness.js';

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

    it('carries the mail behind the number, and only mail that is in both', () => {
        /*
         * „209 davon" is a claim about an overlap, and the screen offers to show it. So the list
         * behind the number has to *be* the overlap: every message in it must be in this category
         * and moved by that rule. A list that quietly held the whole category, or the rule's whole
         * catch, would look right at every count and be wrong at every row.
         */
        const withRules = mailbox.categories.filter((entry) => entry.alsoMovedByRules.length > 0);
        expect(withRules.length).toBeGreaterThan(0);

        for (const entry of withRules) {
            const inCategory = new Set(entry.messages.map((message) => message.ID));
            for (const rule of entry.alsoMovedByRules) {
                expect(rule.messages.length).toBe(rule.count);
                for (const message of rule.messages) {
                    expect(inCategory.has(message.ID)).toBe(true);
                }
            }
        }

        // And together they account for no more than the category itself.
        for (const entry of withRules) {
            const moved = entry.alsoMovedByRules.reduce((total, rule) => total + rule.count, 0);
            expect(moved).toBeLessThanOrEqual(entry.messages.length);
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

    /*
     * Unmounted, not merely detached.
     *
     * Removing the container leaves the React root alive with work still scheduled against it. That
     * work runs after Vitest has torn the DOM environment down, and „ReferenceError: window is not
     * defined" then surfaces as an unhandled error attributed to whichever file happened to be running
     * — which is why the failure moved around and only appeared in the full suite.
     */
    afterEach(() => {
        act(() => {
            root?.unmount();
        });
        root = undefined;
        container.remove();
    });

    let root: Root | undefined;

    it('renders and says that Proton does this sorting itself', () => {
        const next = createRoot(container);
        root = next;
        act(() => {
            next.render(
                <Providers>
                    <CategoriesPage />
                </Providers>
            );
        });

        const text = container.textContent ?? '';
        expect(text).toContain('Kategorien');
        expect(text).toContain('Proton sortiert diese Mail selbst');
        expect(text).toContain('Newsletter');
    });
});
