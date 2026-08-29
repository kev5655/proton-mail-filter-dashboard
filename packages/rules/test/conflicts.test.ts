import { ConditionComparator, ConditionType, FilterStatement, type SimpleObject } from '@proton/sieve/filterModel';
import { describe, expect, it } from 'vitest';

import { analyseRules } from '../src/conflicts.js';
import type { MatchableMessage, OrderedRule } from '../src/matcher.js';

/**
 * The analysis that surfaces a rule doing nothing.
 *
 * Proton shows a filter list and no indication of whether any of it works. A rule can match plenty
 * of mail and still never decide anything, because a later, broader rule files the same message
 * somewhere else — so the user sees a rule that looks right while their mail goes elsewhere. That
 * is the case this exists to catch, and it is invisible without simulating the whole set together.
 */

function rule(values: string[], folder: string, type = ConditionType.SENDER): SimpleObject {
    return {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: type, value: type },
                Comparator: { label: 'contains', value: ConditionComparator.CONTAINS },
                Values: values,
            },
        ],
        Actions: { FileInto: [folder], Mark: { Read: false, Starred: false } },
    };
}

function markOnly(values: string[]): SimpleObject {
    return {
        ...rule(values, ''),
        Actions: { FileInto: [], Mark: { Read: true, Starred: false } },
    };
}

function ordered(id: string, name: string, priority: number, simple: SimpleObject): OrderedRule {
    return { id, name, priority, enabled: true, rule: simple };
}

const from = (address: string): MatchableMessage => ({
    Subject: 'egal',
    Sender: { Address: address },
    ToList: [],
});

describe('rule analysis', () => {
    it('reports a rule that decides where mail goes as active', () => {
        const analysis = analyseRules(
            [ordered('1', 'Google', 1, rule(['google.com'], 'Google'))],
            [from('a@google.com'), from('b@google.com')]
        );

        expect(analysis[0]?.verdict).toBe('active');
        expect(analysis[0]?.decidedCount).toBe(2);
    });

    it('reports a rule matching nothing in the indexed mail', () => {
        const analysis = analyseRules(
            [ordered('1', 'Alt', 1, rule(['ehemaliger-arbeitgeber.example'], 'Archiv'))],
            [from('a@google.com')]
        );

        expect(analysis[0]?.verdict).toBe('never-matches');
        // Phrased as a hint about the indexed window, not as a verdict on the rule itself.
        expect(analysis[0]?.explanation).toMatch(/Zeitraum/);
    });

    it('catches the rule that matches but never wins', () => {
        // The invisible failure: a later catch-all files everything into Archiv, so the specific
        // rule the user carefully wrote never determines anything.
        const specific = ordered('1', 'Google', 1, rule(['google.com'], 'Google'));
        const catchAll = ordered('2', 'Alles', 2, rule(['@'], 'Archiv'));

        const analysis = analyseRules([specific, catchAll], [from('a@google.com'), from('b@example.com')]);
        const google = analysis.find((entry) => entry.ruleId === '1');

        expect(google?.verdict).toBe('always-overridden');
        expect(google?.matchedCount).toBe(1);
        expect(google?.decidedCount).toBe(0);
        expect(google?.overriddenBy[0]?.name).toBe('Alles');
        expect(google?.explanation).toContain('überschreibt');
    });

    it('respects priority rather than array order', () => {
        const catchAll = ordered('2', 'Alles', 1, rule(['@'], 'Archiv'));
        const specific = ordered('1', 'Google', 2, rule(['google.com'], 'Google'));

        // The catch-all runs first here, so the specific rule wins and is active.
        const analysis = analyseRules([specific, catchAll], [from('a@google.com')]);
        expect(analysis.find((entry) => entry.ruleId === '1')?.verdict).toBe('active');
        expect(analysis.find((entry) => entry.ruleId === '2')?.verdict).toBe('always-overridden');
    });

    it('does not call a redundant rule overridden when both file into the same folder', () => {
        const first = ordered('1', 'Erst', 1, rule(['google.com'], 'Archiv'));
        const second = ordered('2', 'Dann', 2, rule(['@'], 'Archiv'));

        const analysis = analyseRules([first, second], [from('a@google.com')]);
        expect(analysis.find((entry) => entry.ruleId === '1')?.overriddenBy).toEqual([]);
    });

    it('ignores rules that only mark, since they override nothing', () => {
        const marker = ordered('1', 'Als gelesen', 1, markOnly(['google.com']));
        const filer = ordered('2', 'Google', 2, rule(['google.com'], 'Google'));

        const analysis = analyseRules([marker, filer], [from('a@google.com')]);
        expect(analysis.find((entry) => entry.ruleId === '1')?.overriddenBy).toEqual([]);
        expect(analysis.find((entry) => entry.ruleId === '2')?.verdict).toBe('active');
    });

    it('leaves disabled rules out entirely', () => {
        const disabled = { ...ordered('1', 'Aus', 1, rule(['@'], 'Archiv')), enabled: false };
        const active = ordered('2', 'Google', 2, rule(['google.com'], 'Google'));

        const analysis = analyseRules([disabled, active], [from('a@google.com')]);
        expect(analysis.map((entry) => entry.ruleId)).toEqual(['2']);
    });

    it('names the most frequent overrider first', () => {
        const specific = ordered('1', 'Google', 1, rule(['google.com'], 'Google'));
        const rare = ordered('2', 'Selten', 2, rule(['a@google.com'], 'Selten'));
        const common = ordered('3', 'Häufig', 3, rule(['@'], 'Archiv'));

        const analysis = analyseRules(
            [specific, rare, common],
            [from('a@google.com'), from('b@google.com'), from('c@google.com')]
        );

        expect(analysis[0]?.overriddenBy[0]?.name).toBe('Häufig');
    });
});
