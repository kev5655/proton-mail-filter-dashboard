import { matchesRule, type MatchableMessage, type OrderedRule } from './matcher.js';

/**
 * Which rules actually do anything.
 *
 * Proton runs every filter in priority order and each matching one performs its actions, so where a
 * message ends up is decided by the *last* rule that files it. That makes it entirely possible to
 * have a rule that matches plenty of mail and yet never determines anything — a later, broader rule
 * quietly overrides it every time. Nothing in Proton's UI shows this. The rule sits there looking
 * correct, and mail keeps going somewhere else.
 *
 * The verdicts below are always relative to the indexed mail, and are phrased that way in the UI: a
 * rule that never matched anything in the last year is a strong hint, not a proof that it is dead.
 */

export type RuleVerdict =
    /** Decides the destination for at least one message. */
    | 'active'
    /** Matches nothing in the indexed mail. */
    | 'never-matches'
    /** Matches, but a later rule always overrides where the message goes. */
    | 'always-overridden';

export interface RuleAnalysis {
    ruleId: string;
    name: string;
    verdict: RuleVerdict;
    matchedCount: number;
    /** How often this rule is the one that decides the destination. */
    decidedCount: number;
    /** Rules that override it, most frequent first. */
    overriddenBy: Array<{ ruleId: string; name: string; count: number }>;
    explanation: string;
}

export function analyseRules(rules: OrderedRule[], messages: MatchableMessage[]): RuleAnalysis[] {
    const ordered = rules.filter((rule) => rule.enabled).sort((a, b) => a.priority - b.priority);

    const matched = new Map<string, number>();
    const decided = new Map<string, number>();
    const overrides = new Map<string, Map<string, number>>();

    for (const message of messages) {
        const hits = ordered.filter((entry) => matchesRule(entry.rule, message));
        for (const hit of hits) {
            matched.set(hit.id, (matched.get(hit.id) ?? 0) + 1);
        }

        // Only rules that actually file the message compete for the destination; one that merely
        // marks it as read does not override anything.
        const filing = hits.filter((hit) => destinationOf(hit) !== undefined);
        const winner = filing.at(-1);
        if (winner === undefined) {
            continue;
        }
        decided.set(winner.id, (decided.get(winner.id) ?? 0) + 1);

        for (const loser of filing.slice(0, -1)) {
            if (destinationOf(loser) === destinationOf(winner)) {
                // Same destination: the later rule is redundant here, not overriding.
                continue;
            }
            const perRule = overrides.get(loser.id) ?? new Map<string, number>();
            perRule.set(winner.id, (perRule.get(winner.id) ?? 0) + 1);
            overrides.set(loser.id, perRule);
        }
    }

    const nameOf = new Map(ordered.map((entry) => [entry.id, entry.name]));

    return ordered.map((entry) => {
        const matchedCount = matched.get(entry.id) ?? 0;
        const decidedCount = decided.get(entry.id) ?? 0;
        const overriddenBy = [...(overrides.get(entry.id) ?? new Map<string, number>())]
            .map(([ruleId, count]) => ({ ruleId, name: nameOf.get(ruleId) ?? ruleId, count }))
            .sort((a, b) => b.count - a.count);

        const verdict: RuleVerdict =
            matchedCount === 0
                ? 'never-matches'
                : decidedCount === 0 && overriddenBy.length > 0
                  ? 'always-overridden'
                  : 'active';

        return {
            ruleId: entry.id,
            name: entry.name,
            verdict,
            matchedCount,
            decidedCount,
            overriddenBy,
            explanation: explainVerdict(entry.name, verdict, matchedCount, decidedCount, overriddenBy),
        };
    });
}

function destinationOf(entry: OrderedRule): string | undefined {
    const target = entry.rule.Actions.FileInto.at(-1);
    return target === undefined || target === '' ? undefined : target;
}

function explainVerdict(
    name: string,
    verdict: RuleVerdict,
    matchedCount: number,
    decidedCount: number,
    overriddenBy: RuleAnalysis['overriddenBy']
): string {
    switch (verdict) {
        case 'never-matches':
            return `„${name}" trifft keine der erfassten Mails. Möglich: die Regel ist veraltet, oder der Zeitraum reicht nicht weit genug zurück.`;
        case 'always-overridden': {
            const winner = overriddenBy[0];
            return `„${name}" trifft ${matchedCount} Mails, entscheidet aber nie, wohin sie gehen — „${winner?.name ?? '?'}" läuft später und überschreibt das Ziel.`;
        }
        default:
            return `„${name}" bestimmt bei ${decidedCount} von ${matchedCount} getroffenen Mails den Zielordner.`;
    }
}
