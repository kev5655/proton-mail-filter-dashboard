import { ConditionComparator, ConditionType, type SimpleObject } from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';
import { describe, expect, it } from 'vitest';

import { matchesRule, protonEscapingIsBroken, type MatchableMessage } from '../src/matcher.js';
import { canExtend, extendRule, literalFragment, ruleFromGroup } from '../src/suggest.js';

/**
 * A suggested rule is the one thing in this project that gets written into someone's live mailbox.
 * So the bar is not "does it look reasonable" but: does it catch the group it was derived from,
 * does it leave everything else alone, and does it survive compilation to what Proton runs.
 */

function message(sender: string, subject = 'egal'): MatchableMessage {
    return { Subject: subject, Sender: { Address: sender }, ToList: [] };
}

describe('rule from a sender group', () => {
    const { rule, explanation } = ruleFromGroup(
        { kind: 'sender', sender: 'no-reply@accounts.google.com' },
        'Security/Logins'
    );

    it('catches the sender it was built from', () => {
        expect(matchesRule(rule, message('no-reply@accounts.google.com'))).toBe(true);
    });

    it('does not catch a lookalike address', () => {
        expect(matchesRule(rule, message('no-reply@accounts.google.com.evil.example'))).toBe(false);
        expect(matchesRule(rule, message('someone@accounts.google.com'))).toBe(false);
    });

    it('reads back in German rather than as JSON', () => {
        expect(explanation).toBe('Absender ist genau „no-reply@accounts.google.com" → nach „Security/Logins"');
    });

    it('compiles to something Proton accepts', () => {
        expect(() => toSieveTree(rule, 2)).not.toThrow();
    });
});

describe('rule from a domain group', () => {
    const { rule } = ruleFromGroup({ kind: 'domain', domain: 'google.com' }, 'Google');

    it('catches the domain and its subdomains', () => {
        expect(matchesRule(rule, message('billing@google.com'))).toBe(true);
        expect(matchesRule(rule, message('no-reply@accounts.google.com'))).toBe(true);
    });

    it('does not catch a domain that merely ends in the same letters', () => {
        // The trap a naive `contains "google.com"` walks into.
        expect(matchesRule(rule, message('hi@notgoogle.com'))).toBe(false);
        expect(matchesRule(rule, message('hi@google.com.evil.example'))).toBe(false);
    });

    it('stays one readable condition', () => {
        expect(rule.Conditions).toHaveLength(1);
        expect(rule.Conditions[0]?.Comparator.value).toBe(ConditionComparator.ENDS);
    });
});

describe('rule from a sender-plus-subject group', () => {
    const { rule } = ruleFromGroup(
        {
            kind: 'sender-subject',
            sender: 'billing@shop.example',
            subjectTemplate: 'Ihre Rechnung {n} über {amount}',
        },
        'Finanzen'
    );

    it('matches on the literal part of the template, not the placeholders', () => {
        expect(matchesRule(rule, message('billing@shop.example', 'Ihre Rechnung 8891 über CHF 42.10'))).toBe(
            true
        );
    });

    it('leaves the sender\'s other mail alone, which is the whole reason for the split', () => {
        expect(matchesRule(rule, message('billing@shop.example', 'Newsletter August'))).toBe(false);
    });

    it('never emits a placeholder as a literal to match on', () => {
        const subjectCondition = rule.Conditions.find((c) => c.Type.value === ConditionType.SUBJECT);
        expect(subjectCondition?.Values.join()).not.toMatch(/\{(n|amount|date|time|id)\}/);
    });

    it('picks the longest literal run', () => {
        expect(literalFragment('Ihre Rechnung {n} über {amount}')).toBe('Ihre Rechnung');
        expect(literalFragment('{n} Neue Anmeldung bei deinem Konto')).toBe('Neue Anmeldung bei deinem Konto');
    });

    it('gives up rather than matching on a scrap', () => {
        // A three-character fragment would catch far more than the group.
        expect(literalFragment('{n} ab {n}')).toBe('');
    });
});

describe('suggestions avoid the escaping defect', () => {
    it('never suggests a starts/ends rule whose value Proton would mangle', () => {
        // `ends` is used for domain rules, and Proton's escaping breaks on wildcards. A domain
        // cannot contain one, but this pins the property rather than trusting it.
        const { rule } = ruleFromGroup({ kind: 'domain', domain: 'google.com' }, 'Google');
        expect(protonEscapingIsBroken(rule)).toEqual([]);
    });
});

describe('extending an existing rule instead of adding another', () => {
    const existing = ruleFromGroup({ kind: 'sender', sender: 'a@example.com' }, 'Archiv').rule;
    const addition = ruleFromGroup({ kind: 'sender', sender: 'b@example.com' }, 'Archiv').rule;

    it('merges two rules of the same shape and destination', () => {
        expect(canExtend(existing, addition)).toBe(true);

        const merged = extendRule(existing, addition);
        expect(merged.Conditions[0]?.Values).toEqual(['a@example.com', 'b@example.com']);
        expect(matchesRule(merged, message('a@example.com'))).toBe(true);
        expect(matchesRule(merged, message('b@example.com'))).toBe(true);
    });

    it('does not merge rules that file into different folders', () => {
        const elsewhere = ruleFromGroup({ kind: 'sender', sender: 'c@example.com' }, 'Anderswo').rule;
        expect(canExtend(existing, elsewhere)).toBe(false);
    });

    it('does not merge differently shaped rules, which would change the first one\'s meaning', () => {
        const domainRule = ruleFromGroup({ kind: 'domain', domain: 'example.com' }, 'Archiv').rule;
        const twoConditions = ruleFromGroup(
            { kind: 'sender-subject', sender: 'd@example.com', subjectTemplate: 'Rechnung {n}' },
            'Archiv'
        ).rule;

        expect(canExtend(existing, domainRule)).toBe(false);
        expect(canExtend(existing, twoConditions)).toBe(false);
        expect(() => extendRule(existing, domainRule)).toThrow(/separate rule/);
    });

    it('does not duplicate a value that is already there', () => {
        const merged = extendRule(existing, existing as SimpleObject);
        expect(merged.Conditions[0]?.Values).toEqual(['a@example.com']);
    });
});
