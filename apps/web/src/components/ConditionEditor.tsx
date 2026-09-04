import { ConditionType, type ConditionComparator } from '@proton/sieve/filterModel';

import { COMPARATORS, FIELDS } from '../rules/labels.js';
import type { DraftCondition } from '../rules/draft.js';
import { ValueChips } from './ValueChips.js';

/**
 * One condition, laid out the way Proton lays it out: field, comparison, values.
 *
 * The field list is exactly four entries and cannot grow — Proton's tree filters test `subject`,
 * `sender`, `recipient` and `attachments`, and nothing else. That is worth saying on the screen
 * rather than only in a comment, because "filter by content" is the first thing anyone asks for and
 * the answer is not "not yet".
 *
 * Negation is folded into the comparison list, as Proton does it, rather than being a separate
 * toggle: „enthält nicht" is one choice to make instead of two.
 */
export function ConditionEditor({
    condition,
    index,
    total,
    onChange,
    onRemove,
    problems,
    warnedValues,
}: {
    condition: DraftCondition;
    index: number;
    total: number;
    onChange: (next: DraftCondition) => void;
    onRemove: () => void;
    /** Messages addressed to this condition, shown under it rather than in a list elsewhere. */
    problems: Array<{ level: 'error' | 'warning'; message: string }>;
    warnedValues: ReadonlySet<string>;
}): React.JSX.Element {
    const isAttachments = condition.type === ConditionType.ATTACHMENTS;

    return (
        <div className="condition-editor">
            <div className="condition-editor-row">
                <select
                    className="text-input"
                    value={condition.type}
                    aria-label="Feld"
                    onChange={(event) => {
                        const type = event.target.value as ConditionType;
                        // Values from another field rarely mean anything here — an address kept
                        // after switching to Betreff is a condition that quietly matches nothing.
                        onChange({ ...condition, type, values: [], pending: '' });
                    }}
                >
                    {FIELDS.map((field) => (
                        <option key={field.value} value={field.value}>
                            {field.label}
                        </option>
                    ))}
                </select>

                <select
                    className="text-input"
                    value={condition.comparator}
                    aria-label="Vergleich"
                    onChange={(event) =>
                        onChange({ ...condition, comparator: event.target.value as ConditionComparator })
                    }
                >
                    {COMPARATORS.map((comparator) => (
                        <option key={comparator.value} value={comparator.value}>
                            {comparator.label}
                        </option>
                    ))}
                </select>

                {total > 1 && (
                    <button
                        type="button"
                        className="button button-quiet"
                        onClick={onRemove}
                        aria-label={`Bedingung ${String(index + 1)} entfernen`}
                    >
                        Entfernen
                    </button>
                )}
            </div>

            {isAttachments ? (
                <p className="faint">
                    Proton prüft hier nur, ob überhaupt ein Anhang vorhanden ist. Ein Wert wird nicht
                    ausgewertet.
                </p>
            ) : (
                <ValueChips
                    values={condition.values}
                    pending={condition.pending}
                    warnings={warnedValues}
                    onUpdate={(next) => onChange({ ...condition, ...next })}
                />
            )}

            {problems.map((problem) => (
                <p
                    key={problem.message}
                    className={problem.level === 'error' ? 'notice notice-danger' : 'notice notice-warning'}
                >
                    {problem.message}
                </p>
            ))}
        </div>
    );
}
