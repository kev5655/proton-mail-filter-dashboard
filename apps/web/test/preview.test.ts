import { generateMailbox } from '@pms/demo';
import { matchesRule } from '@pms/rules';
import { ConditionComparator, ConditionType, FilterStatement } from '@proton/sieve/filterModel';
import { describe, expect, it } from 'vitest';

import { toSimpleObject, type RuleDraft } from '../src/rules/draft.js';
import { buildIndex, conditionSignature, diffAgainst, evaluateDraft, messagesOf } from '../src/rules/preview.js';

/**
 * The preview is an optimisation, and this is what makes it safe to have one.
 *
 * `evaluateDraft` does not use `matchesRule`. It evaluates each condition into a bitset and
 * combines them with `&` and `|`, which is the only way the editor can recompute on every edit over
 * a real mailbox. That means there are now two implementations of "what does this rule catch", and
 * the fast one decides what the user sees.
 *
 * So every test here compares the two against the same mailbox. If they ever disagree, the preview
 * is lying about someone's mail — and the failure has to be here rather than on a screen.
 */

const messages = generateMailbox();
const index = buildIndex(messages);

function draft(over: Partial<RuleDraft> = {}): RuleDraft {
    return {
        ruleId: undefined,
        name: 'Test',
        operator: FilterStatement.ALL,
        conditions: [],
        folder: 'Ziel',
        markRead: false,
        markStarred: false,
        enabled: true,
        ...over,
    };
}

function condition(
    type: ConditionType,
    comparator: ConditionComparator,
    values: string[],
    uid = 'c'
): RuleDraft['conditions'][number] {
    return { uid, type, comparator, values, pending: '' };
}

/** What the trusted path says, for the same draft. */
function viaMatcher(entry: RuleDraft): string[] {
    const compiled = toSimpleObject(entry);
    return messages.filter((message) => matchesRule(compiled, message)).map((message) => message.ID);
}

function viaPreview(entry: RuleDraft): string[] {
    const { matched } = evaluateDraft(index, entry);
    return messagesOf(index, matched).map((message) => message.ID);
}

describe('the bitset agrees with the matcher', () => {
    const cases: Array<[string, RuleDraft]> = [
        [
            'a sender contains',
            draft({ conditions: [condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'])] }),
        ],
        [
            'a sender is exactly',
            draft({
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.IS, ['noreply@bahn.example']),
                ],
            }),
        ],
        [
            'a subject starts with — the comparator with Proton’s escaping defect',
            draft({ conditions: [condition(ConditionType.SUBJECT, ConditionComparator.STARTS, ['Ihre'])] }),
        ],
        [
            'a sender ends with',
            draft({ conditions: [condition(ConditionType.SENDER, ConditionComparator.ENDS, ['.example'])] }),
        ],
        [
            'a pattern',
            draft({ conditions: [condition(ConditionType.SUBJECT, ConditionComparator.MATCHES, ['*Rechnung*'])] }),
        ],
        [
            'a negation',
            draft({
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.DOES_NOT_CONTAIN, ['bahn']),
                ],
            }),
        ],
        [
            'attachments, whose values are ignored',
            draft({ conditions: [condition(ConditionType.ATTACHMENTS, ConditionComparator.IS, [])] }),
        ],
        [
            'several values in one condition, which are OR-ed',
            draft({
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn', 'lohn', 'miete']),
                ],
            }),
        ],
        [
            'two conditions joined with ALL',
            draft({
                operator: FilterStatement.ALL,
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['@'], 'a'),
                    condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, ['e'], 'b'),
                ],
            }),
        ],
        [
            'two conditions joined with ANY',
            draft({
                operator: FilterStatement.ANY,
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'], 'a'),
                    condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, ['Lohn'], 'b'),
                ],
            }),
        ],
        [
            'three conditions, mixed fields',
            draft({
                operator: FilterStatement.ALL,
                conditions: [
                    condition(ConditionType.SENDER, ConditionComparator.ENDS, ['.example'], 'a'),
                    condition(ConditionType.SUBJECT, ConditionComparator.DOES_NOT_CONTAIN, ['xyz'], 'b'),
                    condition(ConditionType.ATTACHMENTS, ConditionComparator.IS_NOT, [], 'c'),
                ],
            }),
        ],
    ];

    it.each(cases)('%s', (_name, entry) => {
        expect(viaPreview(entry)).toEqual(viaMatcher(entry));
    });

    it('agrees on a rule with no usable condition, which catches everything', () => {
        const entry = draft({ conditions: [] });

        expect(evaluateDraft(index, entry).count).toBe(messages.length);
        expect(viaPreview(entry)).toEqual(viaMatcher(entry));
    });

    it('ignores a condition that has no value yet, instead of matching nothing', () => {
        // While the first value is being typed, an ALL-rule would otherwise flash empty.
        const entry = draft({
            conditions: [
                condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'], 'a'),
                condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, [], 'b'),
            ],
        });

        expect(viaPreview(entry)).toEqual(viaMatcher(entry));
        expect(evaluateDraft(index, entry).count).toBeGreaterThan(0);
    });
});

describe('the cache', () => {
    it('keys on what a condition is, not on which one it is', () => {
        const left = condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'], 'a');
        const right = condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'], 'b');

        expect(conditionSignature(left)).toBe(conditionSignature(right));
    });

    it('does not let a half-typed value change the result', () => {
        const committed = condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'], 'a');
        const typing = { ...committed, pending: 'noch nicht bestätigt' };

        expect(conditionSignature(typing)).toBe(conditionSignature(committed));
    });

    it('reuses the result rather than rescanning', () => {
        const fresh = buildIndex(messages);
        const entry = draft({
            conditions: [condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'])],
        });

        evaluateDraft(fresh, entry);
        expect(fresh.cache.size).toBe(1);

        // Renaming the rule must not invalidate anything: the name is not part of matching.
        evaluateDraft(fresh, { ...entry, name: 'Anders' });
        expect(fresh.cache.size).toBe(1);
    });
});

describe('the difference from what is saved', () => {
    it('counts what the change adds and removes', () => {
        const saved = new Uint8Array([1, 1, 0, 0]);
        const edited = new Uint8Array([1, 0, 1, 0]);

        expect(diffAgainst(saved, edited)).toEqual({ added: 1, removed: 1 });
    });

    it('treats a shorter saved set as all-zero rather than throwing', () => {
        expect(diffAgainst(new Uint8Array([]), new Uint8Array([1, 1]))).toEqual({ added: 2, removed: 0 });
    });
});

describe('the complement', () => {
    it('is exactly what the rule does not catch', () => {
        const entry = draft({
            conditions: [condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['bahn'])],
        });
        const { matched } = evaluateDraft(index, entry);

        const hit = messagesOf(index, matched, 1).length;
        const missed = messagesOf(index, matched, 0).length;

        expect(hit + missed).toBe(messages.length);
    });
});
