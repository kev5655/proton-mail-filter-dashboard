import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type FilterCondition,
    type SimpleObject,
} from '@proton/sieve/filterModel';

/**
 * Turning a group into a rule Proton can run.
 *
 * The constraint that shapes everything here: a suggested rule must be one the user can read back
 * in Proton's own filter UI and understand. That rules out cleverness. A condition matching exactly
 * what the group is — this sender, this subject shape, this organisation — is worth more than a
 * tighter one nobody can verify at a glance.
 *
 * It also has to stay inside what Tree filters can express: sender, recipient, subject, attachments,
 * and the comparators Proton offers. Anything beyond that would compile to Sieve and stop being
 * editable in their UI, which is a trade-off the user should choose, not one a suggestion imposes.
 */

export interface SuggestionInput {
    kind: 'sender' | 'sender-subject' | 'domain';
    sender?: string | undefined;
    domain?: string | undefined;
    subjectTemplate?: string | undefined;
}

export interface RuleSuggestion {
    rule: SimpleObject;
    /** Plain-language rendering of the conditions, for the confirmation dialog. */
    explanation: string;
}

/**
 * The literal part of a subject template that is worth matching on.
 *
 * A template like `Ihre Rechnung {n} über {amount}` cannot be used directly: `contains` is literal,
 * so the placeholders would be matched as text. The longest run of real characters is both the most
 * distinctive part and the part a person recognises — "Ihre Rechnung".
 */
export function literalFragment(template: string): string {
    const runs = template
        .split(/\{(?:date|time|amount|id|n)\}/)
        .map((run) => run.trim())
        .filter((run) => run.length >= 4);

    return runs.sort((a, b) => b.length - a.length)[0] ?? '';
}

export function ruleFromGroup(input: SuggestionInput, folder: string): RuleSuggestion {
    const conditions: FilterCondition[] = [];

    if (input.sender !== undefined && input.sender !== '') {
        conditions.push(condition(ConditionType.SENDER, ConditionComparator.IS, [input.sender]));
    }

    if (input.domain !== undefined && input.domain !== '') {
        // Two values, OR-ed: the domain itself and any subdomain. `@google.com` alone would miss
        // `accounts.google.com`, and a bare `google.com` under `contains` would also match
        // `notgoogle.com.example` — this is the precise form and still one readable condition.
        conditions.push(
            condition(ConditionType.SENDER, ConditionComparator.ENDS, [
                `@${input.domain}`,
                `.${input.domain}`,
            ])
        );
    }

    const fragment =
        input.subjectTemplate === undefined ? '' : literalFragment(input.subjectTemplate);
    if (fragment !== '') {
        conditions.push(condition(ConditionType.SUBJECT, ConditionComparator.CONTAINS, [fragment]));
    }

    const rule: SimpleObject = {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: conditions,
        Actions: { FileInto: [folder], Mark: { Read: false, Starred: false } },
    };

    return { rule, explanation: explain(rule, folder) };
}

/**
 * Widen an existing rule to also cover a new group, when that is possible without changing what it
 * already does.
 *
 * Extending beats creating: a mailbox with forty near-identical rules is its own kind of mess, and
 * every extra rule is one more thing whose order matters. But it is only safe when the shapes line
 * up — same single condition type, same comparator, same destination. Anything else must be a new
 * rule, because merging two differently-shaped rules silently changes the meaning of the first.
 */
export function canExtend(existing: SimpleObject, addition: SimpleObject): boolean {
    if (existing.Conditions.length !== 1 || addition.Conditions.length !== 1) {
        return false;
    }
    const left = existing.Conditions[0] as FilterCondition;
    const right = addition.Conditions[0] as FilterCondition;

    return (
        left.Type.value === right.Type.value &&
        left.Comparator.value === right.Comparator.value &&
        sameDestination(existing, addition)
    );
}

export function extendRule(existing: SimpleObject, addition: SimpleObject): SimpleObject {
    if (!canExtend(existing, addition)) {
        throw new Error('Rules do not have the same shape; create a separate rule instead.');
    }

    const left = existing.Conditions[0] as FilterCondition;
    const right = addition.Conditions[0] as FilterCondition;
    const values = [...new Set([...left.Values, ...right.Values])];

    return {
        ...existing,
        Conditions: [{ ...left, Values: values }],
    };
}

function sameDestination(a: SimpleObject, b: SimpleObject): boolean {
    return a.Actions.FileInto.at(-1) === b.Actions.FileInto.at(-1);
}

function condition(
    type: ConditionType,
    comparator: ConditionComparator,
    values: string[]
): FilterCondition {
    return {
        Type: { label: LABELS[type] ?? type, value: type },
        Comparator: { label: COMPARATOR_LABELS[comparator] ?? comparator, value: comparator },
        Values: values,
    };
}

const LABELS: Partial<Record<ConditionType, string>> = {
    [ConditionType.SENDER]: 'Sender',
    [ConditionType.SUBJECT]: 'Subject',
    [ConditionType.RECIPIENT]: 'Recipient',
    [ConditionType.ATTACHMENTS]: 'Attachments',
};

const COMPARATOR_LABELS: Partial<Record<ConditionComparator, string>> = {
    [ConditionComparator.IS]: 'is exactly',
    [ConditionComparator.CONTAINS]: 'contains',
    [ConditionComparator.ENDS]: 'ends with',
    [ConditionComparator.STARTS]: 'begins with',
    [ConditionComparator.MATCHES]: 'matches',
};

/** German rendering of a rule, so the confirmation dialog does not show JSON. */
export function explain(rule: SimpleObject, folder: string): string {
    const joiner = rule.Operator.value === FilterStatement.ANY ? ' oder ' : ' und ';

    const parts = rule.Conditions.map((entry) => {
        const field = FIELD_NAMES[entry.Type.value] ?? entry.Type.value;
        const comparator = GERMAN_COMPARATORS[entry.Comparator.value] ?? entry.Comparator.value;
        const values = entry.Values.map((value) => `„${value}"`).join(' oder ');
        return entry.Type.value === ConditionType.ATTACHMENTS
            ? `${field} ${comparator}`
            : `${field} ${comparator} ${values}`;
    });

    const conditionText = parts.length === 0 ? 'Jede Mail' : parts.join(joiner);
    return `${conditionText} → nach „${folder}"`;
}

const FIELD_NAMES: Partial<Record<ConditionType, string>> = {
    [ConditionType.SENDER]: 'Absender',
    [ConditionType.SUBJECT]: 'Betreff',
    [ConditionType.RECIPIENT]: 'Empfänger',
    [ConditionType.ATTACHMENTS]: 'Anhang',
};

const GERMAN_COMPARATORS: Partial<Record<ConditionComparator, string>> = {
    [ConditionComparator.IS]: 'ist genau',
    [ConditionComparator.CONTAINS]: 'enthält',
    [ConditionComparator.STARTS]: 'beginnt mit',
    [ConditionComparator.ENDS]: 'endet mit',
    [ConditionComparator.MATCHES]: 'passt auf',
    [ConditionComparator.IS_NOT]: 'ist nicht',
    [ConditionComparator.DOES_NOT_CONTAIN]: 'enthält nicht',
    [ConditionComparator.DOES_NOT_START]: 'beginnt nicht mit',
    [ConditionComparator.DOES_NOT_END]: 'endet nicht mit',
    [ConditionComparator.DOES_NOT_MATCH]: 'passt nicht auf',
};

/**
 * Build a rule from criteria a language model proposed.
 *
 * The model's output has already been validated for shape by `@pms/llm`; this maps it onto Proton's
 * own enums, which is the point where an invented comparator would otherwise become a filter. The
 * mapping is exhaustive and throws on anything unrecognised rather than defaulting, because a
 * silent default here means a rule that matches something other than what was proposed.
 */
export interface ProposedCondition {
    field: 'sender' | 'subject' | 'recipient' | 'attachments';
    comparator: 'contains' | 'is' | 'starts' | 'ends' | 'matches';
    values: string[];
}

const FIELD_MAP: Record<ProposedCondition['field'], ConditionType> = {
    sender: ConditionType.SENDER,
    subject: ConditionType.SUBJECT,
    recipient: ConditionType.RECIPIENT,
    attachments: ConditionType.ATTACHMENTS,
};

const COMPARATOR_MAP: Record<ProposedCondition['comparator'], ConditionComparator> = {
    contains: ConditionComparator.CONTAINS,
    is: ConditionComparator.IS,
    starts: ConditionComparator.STARTS,
    ends: ConditionComparator.ENDS,
    matches: ConditionComparator.MATCHES,
};

export function ruleFromCriteria(
    criteria: ProposedCondition[],
    operator: 'all' | 'any',
    folder: string
): RuleSuggestion {
    const conditions = criteria.map((entry) => {
        const type = FIELD_MAP[entry.field];
        const comparator = COMPARATOR_MAP[entry.comparator];
        if (type === undefined || comparator === undefined) {
            throw new Error(`Unbekannte Bedingung: ${entry.field} ${entry.comparator}`);
        }
        return condition(type, comparator, entry.values);
    });

    const rule: SimpleObject = {
        Operator: {
            label: operator,
            value: operator === 'any' ? FilterStatement.ANY : FilterStatement.ALL,
        },
        Conditions: conditions,
        Actions: { FileInto: [folder], Mark: { Read: false, Starred: false } },
    };

    return { rule, explanation: explain(rule, folder) };
}
