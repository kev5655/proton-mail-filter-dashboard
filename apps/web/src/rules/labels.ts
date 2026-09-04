import { ConditionComparator, ConditionType, FilterStatement } from '@proton/sieve/filterModel';

/**
 * The German words for the parts of a rule.
 *
 * One copy, shared by the editor's dropdowns and by the read-only rendering in `RuleConditions`.
 * They were duplicated while the editor did not exist; two copies of a label map drift, and the
 * drift shows up as a diff dialog describing a rule differently from the screen it was built on —
 * which is the one place a user is being asked to trust what they read.
 */

/** Everything Proton can filter on. There is no fifth entry, and `select` is a placeholder. */
export const FIELDS: Array<{ value: ConditionType; label: string }> = [
    { value: ConditionType.SENDER, label: 'Absender' },
    { value: ConditionType.SUBJECT, label: 'Betreff' },
    { value: ConditionType.RECIPIENT, label: 'Empfänger' },
    { value: ConditionType.ATTACHMENTS, label: 'Anhang' },
];

export const FIELD_NAMES: Partial<Record<ConditionType, string>> = Object.fromEntries(
    FIELDS.map((field) => [field.value, field.label])
);

/**
 * The comparisons, positive first and their negations after.
 *
 * `matches` is offered last and described plainly: it is the only one where the value is a pattern
 * rather than text, and Proton's escaping of `starts`/`ends` is defective in a way that makes a
 * `*` in those values behave unexpectedly — `protonEscapingIsBroken` warns about it in place.
 */
export const COMPARATORS: Array<{ value: ConditionComparator; label: string }> = [
    { value: ConditionComparator.CONTAINS, label: 'enthält' },
    { value: ConditionComparator.IS, label: 'ist genau' },
    { value: ConditionComparator.STARTS, label: 'beginnt mit' },
    { value: ConditionComparator.ENDS, label: 'endet mit' },
    { value: ConditionComparator.MATCHES, label: 'passt auf das Muster' },
    { value: ConditionComparator.DOES_NOT_CONTAIN, label: 'enthält nicht' },
    { value: ConditionComparator.IS_NOT, label: 'ist nicht' },
    { value: ConditionComparator.DOES_NOT_START, label: 'beginnt nicht mit' },
    { value: ConditionComparator.DOES_NOT_END, label: 'endet nicht mit' },
    { value: ConditionComparator.DOES_NOT_MATCH, label: 'passt nicht auf das Muster' },
];

export const COMPARATOR_NAMES: Record<string, string> = Object.fromEntries(
    COMPARATORS.map((comparator) => [comparator.value, comparator.label])
);

/** Proton's wording for the two ways of joining conditions. */
export const STATEMENTS: Array<{ value: FilterStatement; label: string; hint: string }> = [
    {
        value: FilterStatement.ALL,
        label: 'ALLE',
        hint: 'Filtern, wenn ALLE der folgenden Bedingungen erfüllt sind',
    },
    {
        value: FilterStatement.ANY,
        label: 'IRGENDEINE',
        hint: 'Filtern, wenn IRGENDEINE der folgenden Bedingungen erfüllt ist',
    },
];
