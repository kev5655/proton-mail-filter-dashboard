import { DEMO_FOLDERS, DEMO_RULES } from '@pms/demo';
import { matchesRule } from '@pms/rules';
import { generateMailbox } from '@pms/demo';
import { ConditionComparator, ConditionType, FilterStatement } from '@proton/sieve/filterModel';
import { describe, expect, it } from 'vitest';

import {
    emptyCondition,
    fromRule,
    isDirty,
    isExpressibleAsTree,
    newDraft,
    toSimpleObject,
    validateDraft,
} from '../src/rules/draft.js';

/**
 * Editing a rule must not change it.
 *
 * The editor's whole risk is here: opening a rule and saving it without touching anything has to
 * produce the same rule. Anything less means a user who opens a filter to look at it can silently
 * alter what happens to their mail — and the alteration would show up as mail quietly going
 * somewhere else, weeks later, with nothing to point at.
 *
 * Round-tripping the demo rules covers the shapes that matter, including the Sieve-authored one
 * that Proton's own interface refuses to edit.
 */

const messages = generateMailbox();

describe('opening and saving a rule unchanged', () => {
    it.each(DEMO_RULES.map((rule) => [rule.name, rule] as const))('leaves „%s" alone', (_name, rule) => {
        const round = toSimpleObject(fromRule(rule));

        expect(round.Operator.value).toBe(rule.rule.Operator.value);
        expect(round.Conditions).toHaveLength(rule.rule.Conditions.length);
        expect(round.Actions.FileInto).toEqual(rule.rule.Actions.FileInto);
        expect(round.Actions.Mark).toEqual(rule.rule.Actions.Mark);

        for (const [index, condition] of round.Conditions.entries()) {
            const original = rule.rule.Conditions[index];
            expect(condition.Type.value).toBe(original?.Type.value);
            expect(condition.Comparator.value).toBe(original?.Comparator.value);
            expect(condition.Values).toEqual(original?.Values);
        }
    });

    it('catches exactly the same mail afterwards', () => {
        // The assertion that matters more than shape equality: the rule still does the same thing.
        for (const rule of DEMO_RULES) {
            const round = toSimpleObject(fromRule(rule));
            const before = messages.filter((message) => matchesRule(rule.rule, message)).map((m) => m.ID);
            const after = messages.filter((message) => matchesRule(round, message)).map((m) => m.ID);

            expect(after, rule.name).toEqual(before);
        }
    });

    it('reports no change when nothing was touched', () => {
        for (const rule of DEMO_RULES) {
            const draft = fromRule(rule);
            expect(isDirty(draft, { ...draft })).toBe(false);
        }
    });
});

describe('what counts as a change', () => {
    const base = fromRule(DEMO_RULES[1] as (typeof DEMO_RULES)[number]);

    it('a new value does', () => {
        const edited = {
            ...base,
            conditions: base.conditions.map((condition) => ({ ...condition, values: [...condition.values, 'x'] })),
        };
        expect(isDirty(base, edited)).toBe(true);
    });

    it('a different folder does', () => {
        expect(isDirty(base, { ...base, folder: 'Woanders' })).toBe(true);
    });

    it('half-typed text does not — it is not part of the rule yet', () => {
        const typing = {
            ...base,
            conditions: base.conditions.map((condition) => ({ ...condition, pending: 'noch nicht bestätigt' })),
        };
        expect(isDirty(base, typing)).toBe(false);
    });
});

describe('validation', () => {
    it('refuses a rule without a name', () => {
        const problems = validateDraft({ ...newDraft('Ziel'), name: '  ' }, DEMO_FOLDERS);

        expect(problems.some((problem) => problem.level === 'error' && problem.message.includes('Namen'))).toBe(true);
    });

    it('refuses a condition with no value, and points at that condition', () => {
        const draft = { ...newDraft('Ziel'), name: 'Test' };
        const problems = validateDraft(draft, DEMO_FOLDERS);
        const error = problems.find((problem) => problem.level === 'error');

        expect(error?.uid).toBe(draft.conditions[0]?.uid);
    });

    it('warns rather than refuses when a rule would catch everything', () => {
        const draft = { ...newDraft('Ziel'), name: 'Test', conditions: [] };
        const problems = validateDraft(draft, DEMO_FOLDERS);

        // Proton allows it and someone occasionally means it, so this is the user's decision.
        expect(problems.some((problem) => problem.level === 'error')).toBe(false);
        expect(problems.some((problem) => problem.message.includes('jede Mail'))).toBe(true);
    });

    it('says when the target folder does not exist yet', () => {
        const draft = {
            ...newDraft('Gibt Es Nicht'),
            name: 'Test',
            conditions: [{ ...emptyCondition(), values: ['x'] }],
        };
        const problems = validateDraft(draft, DEMO_FOLDERS);

        expect(problems.some((problem) => problem.message.includes('gibt es noch nicht'))).toBe(true);
    });

    it('warns about a wildcard Proton would mangle, on the condition that carries it', () => {
        // The escaping defect in Proton's own compiler: "a*b" as a starts-with matches almost
        // nothing, silently, at Proton as well as here. Better said before the rule is written.
        const broken = {
            ...emptyCondition(ConditionType.SUBJECT),
            comparator: ConditionComparator.STARTS,
            values: ['a*b'],
        };
        const draft = { ...newDraft('Ziel'), name: 'Test', conditions: [broken] };

        const problems = validateDraft(draft, DEMO_FOLDERS);
        const warning = problems.find((problem) => problem.message.includes('a*b'));

        expect(warning?.level).toBe('warning');
        expect(warning?.uid).toBe(broken.uid);
    });

    it('attaches that warning to the right row when an earlier condition was dropped', () => {
        // `toSimpleObject` omits valueless conditions, so compiled indexes and draft indexes
        // diverge — and a warning on the wrong row accuses an innocent value.
        const empty = { ...emptyCondition(ConditionType.SENDER), uid: 'empty' };
        const broken = {
            ...emptyCondition(ConditionType.SUBJECT),
            uid: 'broken',
            comparator: ConditionComparator.ENDS,
            values: ['x*y'],
        };
        const draft = { ...newDraft('Ziel'), name: 'Test', conditions: [empty, broken] };

        const warning = validateDraft(draft, DEMO_FOLDERS).find((problem) => problem.message.includes('x*y'));

        expect(warning?.uid).toBe('broken');
    });
});

describe('whether a rule fits the editor', () => {
    it('accepts the ordinary shapes', () => {
        for (const rule of DEMO_RULES) {
            expect(isExpressibleAsTree(rule.rule), rule.name).toEqual({ expressible: true });
        }
    });

    it('refuses a redirect, and says that is what it refused', () => {
        const rule = {
            ...toSimpleObject({ ...newDraft('Ziel'), name: 'x' }),
            Actions: {
                FileInto: ['Ziel'],
                Mark: { Read: false, Starred: false },
                Redirects: [{ Address: 'woanders@beispiel.example' }],
            },
        };

        const verdict = isExpressibleAsTree(rule);
        expect(verdict.expressible).toBe(false);
        // "Cannot be edited" is useless; naming what would be lost is the point.
        expect(verdict.expressible === false && verdict.reason).toContain('weiter');
    });

    it('refuses more than one destination', () => {
        const rule = {
            Operator: { label: 'all', value: FilterStatement.ALL },
            Conditions: [],
            Actions: { FileInto: ['A', 'B'], Mark: { Read: false, Starred: false } },
        };

        expect(isExpressibleAsTree(rule).expressible).toBe(false);
    });
});
