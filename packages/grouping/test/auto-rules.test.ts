import { describe, expect, it } from 'vitest';

import {
    deriveAutoRules,
    type CategoryChange,
    type CategoryObservation,
} from '../src/auto-rules.js';

/**
 * What we are willing to claim about Proton's sorting, and what we are not.
 *
 * The risk this file guards is not a wrong number. It is a confident sentence: telling someone that
 * Proton "always" files a sender into Werbung on the strength of having looked once. That would be
 * the same rounding-up the rest of the project refuses, in the one place designed to make an
 * invisible rule visible — so most of what follows asserts that the answer is `too-few`.
 */

const SYNC_1 = 1_700_000_000;
const SYNC_2 = 1_700_086_400;
const SYNC_3 = 1_700_172_800;

function observed(
    address: string,
    categoryId: string,
    observedAt: number,
    messageCount = 1
): CategoryObservation {
    return {
        senderAddress: address,
        senderDomain: address.split('@')[1] ?? '',
        categoryId,
        observedAt,
        messageCount,
    };
}

function senderRule(rules: ReturnType<typeof deriveAutoRules>, address: string) {
    return rules.find((rule) => rule.scope.kind === 'sender' && rule.scope.address === address);
}

describe('a single look proves nothing', () => {
    it('says so rather than guessing, even with plenty of mail', () => {
        const rules = deriveAutoRules({
            observations: [observed('shop@beispiel.example', '21', SYNC_1, 40)],
            changes: [],
        });

        // Forty messages in one category, seen once. Still not a pattern: one observation cannot
        // distinguish "Proton always does this" from "Proton did this today".
        expect(senderRule(rules, 'shop@beispiel.example')?.verdict).toEqual({ kind: 'too-few', syncs: 1 });
    });

    it('stays undecided when two syncs agree but the mail is thin', () => {
        const rules = deriveAutoRules({
            observations: [
                observed('selten@beispiel.example', '21', SYNC_1, 1),
                observed('selten@beispiel.example', '21', SYNC_2, 1),
            ],
            changes: [],
        });

        expect(senderRule(rules, 'selten@beispiel.example')?.verdict.kind).toBe('too-few');
    });
});

describe('a pattern held across syncs', () => {
    it('is called stable, and carries what it rests on', () => {
        const rules = deriveAutoRules({
            observations: [
                observed('shop@beispiel.example', '21', SYNC_1, 4),
                observed('shop@beispiel.example', '21', SYNC_2, 5),
                observed('shop@beispiel.example', '21', SYNC_3, 6),
            ],
            changes: [],
        });

        expect(senderRule(rules, 'shop@beispiel.example')?.verdict).toEqual({
            kind: 'stable',
            categoryId: '21',
            since: SYNC_1,
            syncs: 3,
            messages: 6,
        });
        expect(senderRule(rules, 'shop@beispiel.example')?.observedOver).toEqual([SYNC_1, SYNC_2, SYNC_3]);
    });

    it('counts the peak of one sync, not the sum across syncs', () => {
        // Summing would count the same message once per time we looked at it, so a sender observed
        // ten times would appear ten times busier than one observed once — and every "N Mails" on
        // the screen would be wrong in proportion to how long the history is.
        const rules = deriveAutoRules({
            observations: [
                observed('shop@beispiel.example', '21', SYNC_1, 5),
                observed('shop@beispiel.example', '21', SYNC_2, 5),
            ],
            changes: [],
        });

        const verdict = senderRule(rules, 'shop@beispiel.example')?.verdict;
        expect(verdict?.kind === 'stable' && verdict.messages).toBe(5);
    });
});

describe('a sender Proton cannot make up its mind about', () => {
    it('is reported as mixed, with the split shown', () => {
        const rules = deriveAutoRules({
            observations: [
                observed('gemischt@beispiel.example', '21', SYNC_1, 5),
                observed('gemischt@beispiel.example', '25', SYNC_1, 4),
                observed('gemischt@beispiel.example', '21', SYNC_2, 5),
                observed('gemischt@beispiel.example', '25', SYNC_2, 4),
            ],
            changes: [],
        });

        const verdict = senderRule(rules, 'gemischt@beispiel.example')?.verdict;
        expect(verdict?.kind).toBe('mixed');
        // The split is the point: this is the one case where a rule of the user's own is the right
        // answer, and they need the numbers to decide that.
        expect(verdict?.kind === 'mixed' && verdict.shares).toEqual([
            { categoryId: '21', count: 5 },
            { categoryId: '25', count: 4 },
        ]);
    });
});

describe('the moment Proton did something new', () => {
    it('outranks a majority, because it is the interesting sentence', () => {
        // Without this, a sender with a long stable history and one recent change would read as
        // "stable" — and the change, which is the whole reason the screen exists, would vanish
        // under the weight of its own history.
        const changes: CategoryChange[] = [
            {
                messageId: 'm-1',
                senderAddress: 'shop@beispiel.example',
                fromCategory: '24',
                toCategory: '21',
                observedAt: SYNC_3,
            },
        ];
        const rules = deriveAutoRules({
            observations: [
                observed('shop@beispiel.example', '24', SYNC_1, 8),
                observed('shop@beispiel.example', '24', SYNC_2, 8),
                observed('shop@beispiel.example', '21', SYNC_3, 9),
            ],
            changes,
        });

        expect(senderRule(rules, 'shop@beispiel.example')?.verdict).toEqual({
            kind: 'changed',
            from: '24',
            to: '21',
            at: SYNC_3,
            messages: 1,
        });
    });

    it('is sorted to the top', () => {
        const rules = deriveAutoRules({
            observations: [
                observed('ruhig@beispiel.example', '21', SYNC_1, 9),
                observed('ruhig@beispiel.example', '21', SYNC_2, 9),
                observed('neu@anders.example', '25', SYNC_3, 2),
            ],
            changes: [
                {
                    messageId: 'm-9',
                    senderAddress: 'neu@anders.example',
                    fromCategory: undefined,
                    toCategory: '25',
                    observedAt: SYNC_3,
                },
            ],
        });

        expect(rules[0]?.scope).toEqual({ kind: 'sender', address: 'neu@anders.example' });
    });
});

describe('domains alongside senders', () => {
    it('reports both, because we do not know which one Proton uses', () => {
        // Choosing one would be presenting a guess as a finding. Proton may decide by sender, by
        // domain, by content or by something we cannot see; showing both lets the person who reads
        // their own mail judge which fits.
        const rules = deriveAutoRules({
            observations: [
                observed('a@shop.example', '21', SYNC_1, 3),
                observed('b@shop.example', '21', SYNC_1, 3),
                observed('a@shop.example', '21', SYNC_2, 3),
                observed('b@shop.example', '21', SYNC_2, 3),
            ],
            changes: [],
        });

        const domain = rules.find((rule) => rule.scope.kind === 'domain');
        expect(domain?.scope).toEqual({ kind: 'domain', domain: 'shop.example' });
        expect(domain?.verdict.kind).toBe('stable');
    });

    it('leaves out a domain with only one sender, which would say nothing new', () => {
        const rules = deriveAutoRules({
            observations: [
                observed('nur-ich@allein.example', '21', SYNC_1, 3),
                observed('nur-ich@allein.example', '21', SYNC_2, 3),
            ],
            changes: [],
        });

        expect(rules.filter((rule) => rule.scope.kind === 'domain')).toEqual([]);
    });
});
