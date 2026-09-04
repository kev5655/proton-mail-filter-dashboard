import { useRef } from 'react';

/**
 * The values one condition matches on, entered the way Proton's own dialog does it.
 *
 * Each value is a chip, and the word „oder" sits between them — because that is what they are: a
 * condition with three addresses catches mail from any of the three, and writing them as one
 * comma-separated line hides that. It reads as one thing and behaves as three.
 *
 * Committing on Enter, comma and blur rather than on every keystroke is not only about typing
 * comfort. The preview recomputes when the rule changes, and a half-typed address is not yet part
 * of the rule — see `pending` in `draft.ts`. Blur commits too, because leaving a typed value behind
 * and wondering why the preview ignores it is a trap nobody should have to learn about.
 */
export function ValueChips({
    values,
    pending,
    onUpdate,
    placeholder = 'Text oder Schlüsselwort eingeben',
    warnings,
}: {
    values: string[];
    pending: string;
    /**
     * One callback for both, and that is not a style choice.
     *
     * Committing a chip changes the values *and* clears the typed text. As two separate calls, the
     * second one is built from the props this render captured — so it carries the values from
     * before the first call and silently undoes it. The chip appeared and vanished, and typing a
     * value simply did nothing. One update, one truth.
     */
    onUpdate: (next: { values: string[]; pending: string }) => void;
    placeholder?: string;
    /** Values Proton would mangle, so the chip itself can be marked rather than a notice below. */
    warnings?: ReadonlySet<string> | undefined;
}): React.JSX.Element {
    const input = useRef<HTMLInputElement>(null);

    const commit = (): void => {
        const value = pending.trim();
        if (value === '') {
            onUpdate({ values, pending: '' });
            return;
        }
        // Silently dropping a duplicate rather than rejecting it: the same value twice is the same
        // condition, and an error message about it would be pedantry.
        onUpdate({
            values: values.includes(value) ? values : [...values, value],
            pending: '',
        });
    };

    return (
        <div className="chips">
            <div className="chips-input">
                <input
                    ref={input}
                    type="text"
                    className="text-input"
                    value={pending}
                    placeholder={placeholder}
                    onChange={(event) => onUpdate({ values, pending: event.target.value })}
                    onBlur={commit}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault();
                            commit();
                            return;
                        }
                        if (event.key === 'Backspace' && pending === '' && values.length > 0) {
                            onUpdate({ values: values.slice(0, -1), pending });
                        }
                    }}
                    aria-label="Wert für diese Bedingung"
                />
                <button
                    type="button"
                    className="button button-quiet"
                    disabled={pending.trim() === ''}
                    onClick={() => {
                        commit();
                        input.current?.focus();
                    }}
                >
                    Einfügen
                </button>
            </div>

            {values.length > 0 && (
                <div className="chip-list">
                    {values.map((value, index) => (
                        <span key={value}>
                            {index > 0 && <span className="chip-joiner">oder</span>}
                            <span
                                className={
                                    warnings?.has(value) === true ? 'value-chip value-chip-warning' : 'value-chip'
                                }
                            >
                                <code>{value}</code>
                                <button
                                    type="button"
                                    className="chip-remove"
                                    onClick={() => onUpdate({ values: values.filter((entry) => entry !== value), pending })}
                                    aria-label={`„${value}" entfernen`}
                                >
                                    ×
                                </button>
                            </span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
