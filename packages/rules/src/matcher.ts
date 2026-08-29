import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type FilterCondition,
    type SimpleObject,
} from '@proton/sieve/filterModel';
import { escapeCharacters } from '@proton/sieve/helpers';

/**
 * Decide locally which messages a rule catches.
 *
 * Proton will not tell us this. Their filters run server-side and report nothing, so the only way
 * to answer "which mails does this rule affect" — the question the whole dashboard exists to
 * answer — is to reproduce the semantics here and run them over the indexed metadata.
 *
 * That makes this file a *reimplementation of someone else's behaviour*, which is the most
 * dangerous kind of code in the project: when it drifts, nothing crashes, the preview is simply
 * wrong and the user acts on it. Two things keep it honest.
 *
 * First, the semantics are taken from Proton's own compiler rather than assumed. Reading
 * `vendor/proton/sieve/src/toSieve/toSieveTree.helpers.ts` and its fixtures establishes that:
 *
 *   - `sender` is an Address test on `From` with AddressPart `All` — the address, not the display
 *     name. `recipient` covers `To`, `Cc` and `Bcc`.
 *   - Every test carries Format `UnicodeCaseMap`, so comparisons are case-insensitive.
 *   - `starts` and `ends` do not exist in Sieve. Proton rewrites them to `matches` with the value
 *     escaped and a `*` appended or prepended. Their escaping is defective — see
 *     `protonEscapingIsBroken` — and this matcher reproduces the defect rather than correcting it,
 *     because its job is to predict Proton, not to be right.
 *   - `attachments` ignores its values entirely; it compiles to an existence test on `X-Attached`.
 *   - Multiple values inside one condition are OR-ed; the statement joins conditions with AND/OR.
 *
 * Second, M2 adds a health check that looks for messages a rule should have caught but which are
 * still in the inbox. That is the only way to detect drift against the real thing, and until it
 * exists the preview must be presented as an estimate.
 */

/** The subset of message metadata a rule can see. */
export interface MatchableMessage {
    Subject: string;
    Sender: { Address: string; Name?: string | undefined };
    ToList: Array<{ Address: string }>;
    CCList?: Array<{ Address: string }> | undefined;
    BCCList?: Array<{ Address: string }> | undefined;
    NumAttachments?: number | undefined;
}

export function matchesRule(rule: SimpleObject, message: MatchableMessage): boolean {
    const conditions = rule.Conditions;

    // A rule with no conditions matches everything, which is what Sieve does with an empty AllOf.
    if (conditions.length === 0) {
        return true;
    }

    const results = conditions.map((condition) => matchesCondition(condition, message));
    return rule.Operator.value === FilterStatement.ANY ? results.includes(true) : !results.includes(false);
}

export function matchesCondition(condition: FilterCondition, message: MatchableMessage): boolean {
    const comparator = condition.Comparator.value;
    const negated = comparator.startsWith('!');

    if (condition.Type.value === ConditionType.ATTACHMENTS) {
        // Proton compiles this to `exists "X-Attached"` and ignores Values entirely.
        const hasAttachments = (message.NumAttachments ?? 0) > 0;
        return negated ? !hasAttachments : hasAttachments;
    }

    const haystacks = fieldsFor(condition.Type.value, message);
    if (haystacks.length === 0) {
        // Nothing to test against. A positive test cannot match; a negative one vacuously holds,
        // which is how Sieve treats a header that is not present.
        return negated;
    }

    const positive = (comparator.replace('!', '') || ConditionComparator.CONTAINS) as ConditionComparator;

    // Values are OR-ed: Sieve tests take a key list and succeed if any key matches.
    const anyMatch = condition.Values.some((value) =>
        haystacks.some((haystack) => compare(positive, haystack, value))
    );

    return negated ? !anyMatch : anyMatch;
}

function fieldsFor(type: ConditionType, message: MatchableMessage): string[] {
    switch (type) {
        case ConditionType.SUBJECT:
            return [message.Subject];
        case ConditionType.SENDER:
            // AddressPart 'All' means the address itself; the display name is not tested.
            return [message.Sender.Address];
        case ConditionType.RECIPIENT:
            return [
                ...message.ToList.map((entry) => entry.Address),
                ...(message.CCList ?? []).map((entry) => entry.Address),
                ...(message.BCCList ?? []).map((entry) => entry.Address),
            ];
        case ConditionType.ATTACHMENTS:
        case ConditionType.SELECT:
            return [];
        default:
            return [];
    }
}

function compare(comparator: ConditionComparator, haystack: string, needle: string): boolean {
    // UnicodeCaseMap. Not `localeCompare`: Sieve folds case, it does not apply locale collation.
    const left = haystack.toLowerCase();
    const right = needle.toLowerCase();

    switch (comparator) {
        case ConditionComparator.CONTAINS:
            return left.includes(right);
        case ConditionComparator.IS:
            return left === right;
        // Not startsWith/endsWith. Proton has no `starts` in Sieve and rewrites it to a wildcard
        // match over an escaped value, so the faithful prediction is to build the same key and glob
        // it — including the escaping defect described in `protonEscapingIsBroken` below.
        case ConditionComparator.STARTS:
            return globMatches(left, `${escapeCharacters(needle)}*`.toLowerCase());
        case ConditionComparator.ENDS:
            return globMatches(left, `*${escapeCharacters(needle)}`.toLowerCase());
        case ConditionComparator.MATCHES:
            return globMatches(left, right);
        default:
            return false;
    }
}

/**
 * Sieve `:matches` semantics: `*` is any run of characters, `?` is exactly one, and a backslash
 * escapes either. The pattern must cover the whole value.
 */
export function globMatches(value: string, pattern: string): boolean {
    let expression = '';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index] as string;

        if (char === '\\') {
            const next = pattern[index + 1];
            if (next !== undefined) {
                expression += escapeRegExp(next);
                index++;
                continue;
            }
            expression += escapeRegExp(char);
            continue;
        }

        if (char === '*') {
            expression += '[\\s\\S]*';
            continue;
        }
        if (char === '?') {
            expression += '[\\s\\S]';
            continue;
        }
        expression += escapeRegExp(char);
    }

    return new RegExp(`^${expression}$`).test(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which rule wins, given Proton's execution order.
 *
 * Filters run in `Priority` order and each one that matches performs its actions, so several can
 * touch the same message. What decides where it ends up is the last `fileinto` — a later rule
 * moving it again overrides an earlier one. This returns the rules that match, in execution order,
 * so the UI can show both "these rules apply" and "this is the folder it lands in".
 */
export interface OrderedRule {
    id: string;
    name: string;
    priority: number;
    enabled: boolean;
    rule: SimpleObject;
}

export interface MatchOutcome {
    matching: OrderedRule[];
    /** The folder the message ends up in, or undefined when no matching rule moves it. */
    destination: string | undefined;
}

export function resolveOutcome(rules: OrderedRule[], message: MatchableMessage): MatchOutcome {
    const matching = rules
        .filter((entry) => entry.enabled)
        .sort((a, b) => a.priority - b.priority)
        .filter((entry) => matchesRule(entry.rule, message));

    let destination: string | undefined;
    for (const entry of matching) {
        const target = entry.rule.Actions.FileInto.at(-1);
        if (target !== undefined && target !== '') {
            destination = target;
        }
    }

    return { matching, destination };
}

/**
 * Values that Proton will not match the way the user means.
 *
 * `escapeCharacters` in Proton's compiler escapes the wildcards first and the backslashes second:
 *
 *     text.replace(/([*?])/g, '\\$1').replace(/\\/g, '\\\\')
 *
 * so the backslash it just added to neutralise a `*` gets escaped in turn. `a*b` becomes `a\\*b`,
 * which Sieve reads as "a, a literal backslash, anything, b". The star stays a wildcard and a
 * backslash appears out of nowhere. A rule saying "sender begins with a*b" therefore matches almost
 * nothing, and does so silently.
 *
 * This happens inside Proton, not in our preview — the matcher reproduces it deliberately, because
 * predicting the real behaviour is its job. What we can do is refuse to let the user walk into it,
 * which is what this function is for: the UI should warn before such a rule is written, and M2's
 * health check will flag existing ones as never firing.
 */
export interface WildcardWarning {
    conditionIndex: number;
    value: string;
    reason: string;
}

const AFFECTED_COMPARATORS = new Set<string>([
    ConditionComparator.STARTS,
    ConditionComparator.ENDS,
    ConditionComparator.DOES_NOT_START,
    ConditionComparator.DOES_NOT_END,
]);

export function protonEscapingIsBroken(rule: SimpleObject): WildcardWarning[] {
    const warnings: WildcardWarning[] = [];

    rule.Conditions.forEach((condition, conditionIndex) => {
        if (!AFFECTED_COMPARATORS.has(condition.Comparator.value)) {
            return;
        }
        for (const value of condition.Values) {
            if (/[*?\\]/.test(value)) {
                warnings.push({
                    conditionIndex,
                    value,
                    reason:
                        'Proton escapt hier fehlerhaft: das Zeichen bleibt ein Platzhalter und ein ' +
                        'zusätzlicher Backslash kommt dazu. Die Regel greift so gut wie nie.',
                });
            }
        }
    });

    return warnings;
}
