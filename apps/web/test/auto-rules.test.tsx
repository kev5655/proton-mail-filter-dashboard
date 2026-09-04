// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DEMO_CATEGORY_CHANGES,
    DEMO_CATEGORY_OBSERVATIONS,
    DEMO_FOLDERS,
    DEMO_RULES,
    generateMailbox,
} from '@pms/demo';

import { buildMailbox } from '../src/data.js';
import { AutoRulesPage } from '../src/pages/AutoRulesPage.js';
import { Providers } from './harness.js';

/**
 * The screen that makes Proton's invisible sorting visible.
 *
 * Its failure mode is not a crash. It is a screen that reads confidently from thin evidence — that
 * tells someone Proton "always" files a sender somewhere on the strength of one look. So most of
 * what follows checks the wording as much as the data: what is claimed, and what is admitted.
 */

const withHistory = buildMailbox({
    messages: generateMailbox(),
    folders: DEMO_FOLDERS,
    rules: DEMO_RULES,
    categoryObservations: DEMO_CATEGORY_OBSERVATIONS,
    categoryChanges: DEMO_CATEGORY_CHANGES,
});

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    container.remove();
});

/**
 * Rendered through the real providers, which means the demo mailbox — the same history the
 * dashboard shows when no server answers. Rendering the page against a hand-built mailbox would
 * skip `MailboxProvider` and test a shape the application never mounts.
 */
function render(): string {
    const root = createRoot(container);
    act(() => {
        root.render(
            <Providers>
                <AutoRulesPage />
            </Providers>
        );
    });
    const text = container.textContent ?? '';
    act(() => {
        root.unmount();
    });
    return text;
}

describe('the derivation behind the screen', () => {
    it('separates what it can say from what it cannot', () => {
        const senders = withHistory.autoRules.filter((rule) => rule.scope.kind === 'sender');
        const kinds = new Set(senders.map((rule) => rule.verdict.kind));

        // The demo history is built to produce all four, because a screen that has only ever
        // rendered the confident case is a screen whose careful wording has never been seen.
        expect(kinds).toEqual(new Set(['stable', 'changed', 'mixed', 'too-few']));
    });

    it('says nothing about a sender it has seen once, however much mail it brought', () => {
        const once = withHistory.autoRuleFor('erstkontakt@unbekannt.example');
        expect(once?.verdict).toEqual({ kind: 'too-few', syncs: 1 });
    });

    it('reports the sender Proton changed its mind about', () => {
        const changed = withHistory.autoRuleFor('angebote@grossverteiler.example');
        expect(changed?.verdict.kind).toBe('changed');
    });
});

describe('what the screen says', () => {
    it('leads with the change, because that is why it exists', () => {
        const text = render();

        expect(text).toContain('Was sich geändert hat');
        expect(text).toContain('angebote@grossverteiler.example');
        // Named categories, not ids: "24 → 21" is not a sentence anybody can act on.
        expect(text).toContain('Werbung');
    });

    it('states its basis and its two blind spots', () => {
        const text = render();

        expect(text).toContain('Synchronisationen');
        // The incremental sync only fetches new mail, so an old message being re-sorted is simply
        // never looked at again. Without this sentence the screen implies coverage it lacks.
        expect(text).toContain('nicht nachgesehen');
        // And a change may be the user's own, made in Proton's app. We cannot tell the difference
        // and must not imply that we can.
        expect(text).toContain('auseinanderhalten lässt sich das nicht');
    });

    it('refuses to claim a rule, and says only what was observed', () => {
        const text = render();

        expect(text).toContain('Das zeigt, was Proton getan hat — nicht, warum');
    });

    it('offers a rule exactly where Proton does not commit', () => {
        const text = render();

        // The one actionable thing on the page: Proton splits this sender, so nothing is being
        // duplicated by writing a rule of your own.
        expect(text).toContain('Wo Proton sich nicht festlegt');
        expect(text).toContain('Eigene Regel für diesen Absender');
    });

    it('has nothing to say about a copy with no history, and says that', () => {
        // The normal state right after upgrading: the tables exist and are empty. „Keine
        // Änderungen" would be a different and untrue statement — it claims we looked.
        const fresh = buildMailbox({
            messages: generateMailbox(),
            folders: DEMO_FOLDERS,
            rules: DEMO_RULES,
        });

        expect(fresh.autoRules).toEqual([]);
        expect(fresh.categoryCoverage(['irgendeine'])).toEqual([]);
    });
});
