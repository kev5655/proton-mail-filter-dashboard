import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type SimpleObject,
} from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';
import { describe, expect, it } from 'vitest';

import { globMatches, matchesRule, type MatchableMessage } from '../src/matcher.js';

/**
 * The tripwire between the two halves of the rule engine.
 *
 * One half compiles a rule into what Proton actually runs; the other predicts locally what that
 * will catch. They are separate implementations of the same meaning, and the failure mode when they
 * diverge is silent: the preview says one thing, the mailbox does another, and the user only finds
 * out from a mail that went somewhere unexpected.
 *
 * So rather than testing the matcher against its own assumptions, these tests read the semantics
 * back out of the compiler's output and check the matcher against *that*. If a future
 * `pnpm vendor:update` changes how Proton encodes a comparator, this fails — which is the whole
 * point, because nothing else would notice.
 */

interface SieveTest {
    Type?: string;
    Keys?: string[];
    Match?: { Type?: string };
    Format?: { Type?: string };
    Headers?: string[];
    AddressPart?: { Type?: string };
}

function ruleWith(comparator: ConditionComparator, values: string[]): SimpleObject {
    return {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: 'Sender', value: ConditionType.SENDER },
                Comparator: { label: comparator, value: comparator },
                Values: values,
            },
        ],
        Actions: { FileInto: ['Archive'], Mark: { Read: false, Starred: false } },
    };
}

/** Pull the Address test out of the compiled tree, wherever the compiler chose to put it. */
function addressTest(rule: SimpleObject): SieveTest {
    const found: SieveTest[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (node === null || typeof node !== 'object') {
            return;
        }
        const candidate = node as SieveTest;
        if (candidate.Type === 'Address') {
            found.push(candidate);
        }
        Object.values(node).forEach(walk);
    };
    walk(toSieveTree(rule, 2));

    const test = found[0];
    if (test === undefined) {
        throw new Error('compiler produced no Address test — the encoding changed');
    }
    return test;
}

const sender = 'no-reply@accounts.google.com';
const message: MatchableMessage = {
    Subject: 'irrelevant',
    Sender: { Address: sender },
    ToList: [],
};

describe('what the compiler emits', () => {
    it('tests the address itself, case-insensitively', () => {
        // The matcher lowercases both sides and ignores the display name because of these two.
        const test = addressTest(ruleWith(ConditionComparator.CONTAINS, ['google']));

        expect(test.Headers).toEqual(['From']);
        expect(test.AddressPart?.Type).toBe('All');
        expect(test.Format?.Type).toBe('UnicodeCaseMap');
    });

    it('rewrites starts into a wildcard match, and the matcher agrees with the rewrite', () => {
        const rule = ruleWith(ConditionComparator.STARTS, ['no-reply']);
        const test = addressTest(rule);

        expect(test.Match?.Type).toBe('Matches');
        expect(test.Keys).toEqual(['no-reply*']);

        // Read the semantics back out: interpreting the emitted key as a glob must give the same
        // answer as the matcher's startsWith shortcut.
        const viaCompiler = (test.Keys ?? []).some((key) => globMatches(sender, key.toLowerCase()));
        expect(matchesRule(rule, message)).toBe(viaCompiler);
    });

    it('rewrites ends the same way, in the other direction', () => {
        const rule = ruleWith(ConditionComparator.ENDS, ['.com']);
        const test = addressTest(rule);

        expect(test.Match?.Type).toBe('Matches');
        expect(test.Keys).toEqual(['*.com']);

        const viaCompiler = (test.Keys ?? []).some((key) => globMatches(sender, key.toLowerCase()));
        expect(matchesRule(rule, message)).toBe(viaCompiler);
    });

    it("reproduces Proton's broken escaping rather than quietly disagreeing with it", () => {
        // escapeCharacters escapes the wildcards first and the backslashes second, so the backslash
        // it just added to neutralise the `*` gets escaped in turn: "a*b" becomes "a\\*b", which
        // Sieve reads as "a, literal backslash, anything, b". The star survives as a wildcard.
        //
        // That is a defect in Proton and it affects real filters, not just our preview. The matcher
        // predicts Proton, so it must be wrong in the same way — a preview that showed the intended
        // behaviour would be the more dangerous kind of wrong.
        const rule = ruleWith(ConditionComparator.STARTS, ['a*b']);
        const key = (addressTest(rule).Keys?.[0] ?? '').toLowerCase();

        expect(key).toBe('a\\\\*b*');

        const literalStar: MatchableMessage = { ...message, Sender: { Address: 'a*bcd' } };
        const withBackslash: MatchableMessage = { ...message, Sender: { Address: 'a\\xbcd' } };

        // Neither the matcher nor Proton matches the address the user actually meant.
        expect(matchesRule(rule, literalStar)).toBe(false);
        expect(globMatches('a*bcd', key)).toBe(false);

        // Both match the nonsense the escaping produced.
        expect(matchesRule(rule, withBackslash)).toBe(true);
        expect(globMatches('a\\xbcd', key)).toBe(true);
    });

    it('passes a matches pattern through unescaped, so wildcards stay wildcards', () => {
        const test = addressTest(ruleWith(ConditionComparator.MATCHES, ['no-reply@*.com']));
        expect(test.Keys).toEqual(['no-reply@*.com']);
        expect(test.Match?.Type).toBe('Matches');
    });

    it.each([
        [ConditionComparator.CONTAINS, 'Contains'],
        [ConditionComparator.IS, 'Is'],
        [ConditionComparator.MATCHES, 'Matches'],
    ])('maps %s to the Sieve match type %s', (comparator, expected) => {
        expect(addressTest(ruleWith(comparator, ['x'])).Match?.Type).toBe(expected);
    });
});
