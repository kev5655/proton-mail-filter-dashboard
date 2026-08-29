import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type SimpleObject,
} from '@proton/sieve/filterModel';
import { describe, expect, it } from 'vitest';

import {
    globMatches,
    matchesRule,
    protonEscapingIsBroken,
    resolveOutcome,
    type MatchableMessage,
} from '../src/matcher.js';

/**
 * The local matcher decides what the user is shown as "the mails this rule catches". Proton runs
 * the real filters and reports nothing, so this is a reimplementation of behaviour we cannot
 * observe — and when a reimplementation drifts, nothing crashes: the preview is quietly wrong and
 * the user acts on it.
 *
 * These tests therefore aim at the specific places where a plausible guess differs from what
 * Proton's compiler actually does: case folding, where a display name is *not* looked at, wildcards
 * that are only wildcards under `matches`, and how several matching rules resolve to one folder.
 */

function rule(
    conditions: SimpleObject['Conditions'],
    options: { statement?: FilterStatement; fileInto?: string[] } = {}
): SimpleObject {
    return {
        Operator: { label: 'all', value: options.statement ?? FilterStatement.ALL },
        Conditions: conditions,
        Actions: {
            FileInto: options.fileInto ?? ['Archive'],
            Mark: { Read: false, Starred: false },
        },
    };
}

function condition(
    type: ConditionType,
    comparator: ConditionComparator,
    values: string[]
): SimpleObject['Conditions'][number] {
    return {
        Type: { label: type, value: type },
        Comparator: { label: comparator, value: comparator },
        Values: values,
    };
}

const mail: MatchableMessage = {
    Subject: 'Neue Anmeldung bei deinem Google-Konto',
    Sender: { Address: 'no-reply@accounts.google.com', Name: 'Google' },
    ToList: [{ Address: 'kevin@proton.me' }],
    CCList: [{ Address: 'team@example.org' }],
    NumAttachments: 0,
};

describe('comparators', () => {
    it('matches a sender substring', () => {
        const r = rule([condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['accounts.google'])]);
        expect(matchesRule(r, mail)).toBe(true);
    });

    it('folds case, because every Proton test carries UnicodeCaseMap', () => {
        const r = rule([condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, ['ANMELDUNG'])]);
        expect(matchesRule(r, mail)).toBe(true);
    });

    it('distinguishes is from contains', () => {
        const exact = rule([
            condition(ConditionType.SENDER, ConditionComparator.IS, ['no-reply@accounts.google.com']),
        ]);
        const partial = rule([condition(ConditionType.SENDER, ConditionComparator.IS, ['accounts.google'])]);

        expect(matchesRule(exact, mail)).toBe(true);
        expect(matchesRule(partial, mail)).toBe(false);
    });

    it('handles starts and ends', () => {
        expect(
            matchesRule(rule([condition(ConditionType.SENDER, ConditionComparator.STARTS, ['no-reply'])]), mail)
        ).toBe(true);
        expect(
            matchesRule(rule([condition(ConditionType.SENDER, ConditionComparator.ENDS, ['.com'])]), mail)
        ).toBe(true);
    });

    it('negates', () => {
        const r = rule([
            condition(ConditionType.SENDER, ConditionComparator.DOES_NOT_CONTAIN, ['microsoft']),
        ]);
        expect(matchesRule(r, mail)).toBe(true);
    });
});

describe('fields', () => {
    it('tests the sender address, not the display name', () => {
        // Proton compiles `sender` to an Address test with AddressPart 'All'. Matching "Google"
        // here would be a plausible guess and would silently over-report.
        const r = rule([condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['Google'])]);
        const withoutGoogleInAddress: MatchableMessage = {
            ...mail,
            Sender: { Address: 'no-reply@example.com', Name: 'Google' },
        };

        expect(matchesRule(r, withoutGoogleInAddress)).toBe(false);
    });

    it('covers To, Cc and Bcc for recipient', () => {
        const cc = rule([condition(ConditionType.RECIPIENT, ConditionComparator.CONTAINS, ['team@'])]);
        const bcc = rule([condition(ConditionType.RECIPIENT, ConditionComparator.CONTAINS, ['hidden@'])]);

        expect(matchesRule(cc, mail)).toBe(true);
        expect(matchesRule(bcc, { ...mail, BCCList: [{ Address: 'hidden@example.org' }] })).toBe(true);
    });

    it('treats attachments as an existence test and ignores its values', () => {
        const has = rule([condition(ConditionType.ATTACHMENTS, ConditionComparator.CONTAINS, ['ignored'])]);
        const hasNot = rule([
            condition(ConditionType.ATTACHMENTS, ConditionComparator.DOES_NOT_CONTAIN, []),
        ]);

        expect(matchesRule(has, { ...mail, NumAttachments: 2 })).toBe(true);
        expect(matchesRule(has, { ...mail, NumAttachments: 0 })).toBe(false);
        expect(matchesRule(hasNot, { ...mail, NumAttachments: 0 })).toBe(true);
    });

    it('lets a negative test pass when the field is absent, as Sieve does', () => {
        const r = rule([condition(ConditionType.RECIPIENT, ConditionComparator.DOES_NOT_CONTAIN, ['x@y'])]);
        expect(matchesRule(r, { ...mail, ToList: [], CCList: [] })).toBe(true);
    });
});

describe('combining', () => {
    it('ORs the values inside one condition', () => {
        const r = rule([
            condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['microsoft', 'google']),
        ]);
        expect(matchesRule(r, mail)).toBe(true);
    });

    it('ANDs conditions under "all"', () => {
        const r = rule([
            condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['google']),
            condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, ['Rechnung']),
        ]);
        expect(matchesRule(r, mail)).toBe(false);
    });

    it('ORs conditions under "any"', () => {
        const r = rule(
            [
                condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['google']),
                condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, ['Rechnung']),
            ],
            { statement: FilterStatement.ANY }
        );
        expect(matchesRule(r, mail)).toBe(true);
    });

    it('matches everything when there are no conditions', () => {
        expect(matchesRule(rule([]), mail)).toBe(true);
    });
});

describe('wildcards', () => {
    it('treats * and ? as wildcards under matches', () => {
        const r = rule([
            condition(ConditionType.SENDER, ConditionComparator.MATCHES, ['no-reply@*.google.com']),
        ]);
        expect(matchesRule(r, mail)).toBe(true);
    });

    it('anchors the pattern to the whole value', () => {
        expect(globMatches('abc', 'ab')).toBe(false);
        expect(globMatches('abc', 'ab*')).toBe(true);
        expect(globMatches('abc', 'a?c')).toBe(true);
        expect(globMatches('abc', 'a?')).toBe(false);
    });

    it('honours a backslash escape, so a literal star stays literal', () => {
        // The glob itself is correct. What is not is Proton's escaping, which never produces a
        // single backslash — see the escaping test in matcher-agrees-with-compiler.test.ts.
        expect(globMatches('a*c', 'a\\*c')).toBe(true);
        expect(globMatches('abc', 'a\\*c')).toBe(false);
    });

    it('does not let regex metacharacters through', () => {
        expect(globMatches('a.c', 'a.c')).toBe(true);
        expect(globMatches('abc', 'a.c')).toBe(false);
    });
});

describe('which rule wins', () => {
    const toArchive = { id: '1', name: 'Archiv', priority: 1, enabled: true, rule: rule([], { fileInto: ['Archive'] }) };
    const toSecurity = {
        id: '2',
        name: 'Security',
        priority: 2,
        enabled: true,
        rule: rule([condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['google'])], {
            fileInto: ['Security/Logins'],
        }),
    };

    it('reports every matching rule in execution order', () => {
        const outcome = resolveOutcome([toSecurity, toArchive], mail);
        expect(outcome.matching.map((entry) => entry.id)).toEqual(['1', '2']);
    });

    it('lands the message in the folder of the last matching rule', () => {
        // Several filters can touch one message; the last fileinto is where it actually ends up.
        expect(resolveOutcome([toSecurity, toArchive], mail).destination).toBe('Security/Logins');
    });

    it('ignores disabled rules', () => {
        const outcome = resolveOutcome([{ ...toSecurity, enabled: false }, toArchive], mail);
        expect(outcome.destination).toBe('Archive');
    });

    it('reports no destination when nothing matches', () => {
        const unrelated = {
            ...toSecurity,
            rule: rule([condition(ConditionType.SENDER, ConditionComparator.CONTAINS, ['nowhere'])]),
        };
        expect(resolveOutcome([unrelated], mail).destination).toBeUndefined();
    });
});

describe('warning about Proton\'s broken escaping', () => {
    it('flags a wildcard character under starts, which Proton mishandles', () => {
        const warnings = protonEscapingIsBroken(
            rule([condition(ConditionType.SENDER, ConditionComparator.STARTS, ['a*b'])])
        );

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.value).toBe('a*b');
        expect(warnings[0]?.reason).toMatch(/greift so gut wie nie/);
    });

    it('flags ? and backslash too, and the negated variants', () => {
        expect(
            protonEscapingIsBroken(rule([condition(ConditionType.SUBJECT, ConditionComparator.ENDS, ['a?b'])]))
        ).toHaveLength(1);
        expect(
            protonEscapingIsBroken(
                rule([condition(ConditionType.SUBJECT, ConditionComparator.DOES_NOT_START, ['a\\b'])])
            )
        ).toHaveLength(1);
    });

    it('stays quiet for ordinary values', () => {
        expect(
            protonEscapingIsBroken(
                rule([condition(ConditionType.SENDER, ConditionComparator.STARTS, ['no-reply@'])])
            )
        ).toEqual([]);
    });

    it('stays quiet under matches, where a wildcard is what the user asked for', () => {
        expect(
            protonEscapingIsBroken(
                rule([condition(ConditionType.SENDER, ConditionComparator.MATCHES, ['*@google.com'])])
            )
        ).toEqual([]);
    });
});
