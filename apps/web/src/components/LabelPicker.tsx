import { useState } from 'react';

import type { MailboxFolder } from '@pms/server/types';

import { useModel } from '../llm.js';
import { ModelStatus } from './ModelStatus.js';

/**
 * Choosing the label a rule marks with, by hand or with the model's help.
 *
 * The model's part is narrow on purpose, and the rule is Kevin's: **choose from what exists; invent
 * only when nothing fits, and only when asked.** A model told to "suggest labels" invents one every
 * time, and a mailbox grows a dozen near-synonyms — „Rechnung", „Rechnungen", „Belege" — each with
 * its own rule, none of them wrong and all of them noise.
 *
 * So the account's labels always go with the question, and the answer comes back in two parts. What
 * already exists can be taken at once. What the model invented sits apart, labelled as new, behind
 * its own tick — because a label is a thing that will still be in the mailbox in a year, and
 * agreeing to one should be a separate act from agreeing to the rule.
 *
 * Everything here works without a model. The list of existing labels is the primary interface; the
 * model is a shortcut through it.
 */
export function LabelPicker({
    labels,
    values,
    subjects,
    senders,
    disabled = false,
    onChange,
}: {
    labels: readonly MailboxFolder[];
    /**
     * The labels this rule marks with — several, deliberately.
     *
     * A mail can carry „Rechnung" and „Steuer" at once, and while this took a single name the only
     * way to say that was two rules with identical conditions, kept in step by hand. `FileInto` is a
     * list at Proton, so nothing had to be invented for it.
     */
    values: readonly string[];
    /** What the rule currently catches, so the model has something to go on. */
    subjects: readonly string[];
    senders: readonly string[];
    disabled?: boolean;
    onChange: (names: string[]) => void;
}): React.JSX.Element {
    const { provider, state } = useModel();
    const [allowNew, setAllowNew] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [suggestion, setSuggestion] = useState<
        { chosen: string[]; proposedNew: string[]; rationale: string } | undefined
    >(undefined);

    /*
     * Toggling rather than replacing, which is what makes the row read as a set.
     *
     * Order is preserved by appending: `FileInto` is a list, and a rule that reshuffled its labels
     * on every click would show a diff on a change nobody made.
     */
    const toggle = (name: string): void => {
        onChange(values.includes(name) ? values.filter((entry) => entry !== name) : [...values, name]);
    };

    const add = (name: string): void => {
        if (!values.includes(name)) {
            onChange([...values, name]);
        }
    };

    async function ask(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            setSuggestion(
                await provider.proposeLabels({
                    subjects: [...subjects].slice(0, 20),
                    senders: [...new Set(senders)].slice(0, 10),
                    existingLabels: labels.map((label) => label.Name),
                    allowNew,
                })
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="stack" style={{ gap: 10 }}>
            {labels.length > 0 && (
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {labels.map((label) => (
                        <button
                            key={label.ID}
                            type="button"
                            className={
                                values.includes(label.Name) ? 'button' : 'button button-quiet'
                            }
                            aria-pressed={values.includes(label.Name)}
                            disabled={disabled}
                            onClick={() => {
                                toggle(label.Name);
                            }}
                        >
                            {label.Name}
                        </button>
                    ))}
                </div>
            )}

            {labels.length === 0 && (
                <p className="faint">
                    Dieses Postfach hat noch keine Labels. Der Name oben legt beim Speichern eines an.
                </p>
            )}

            <ModelStatus what="können hier keine Labels vorgeschlagen werden" />

            {state === 'available' && (
                <>
                    <div className="row" style={{ gap: 8 }}>
                        <button
                            type="button"
                            className="button button-secondary"
                            disabled={busy}
                            onClick={() => void ask()}
                        >
                            {busy ? (
                                <>
                                    <span className="spinner" aria-hidden="true" />
                                    Frage das Modell …
                                </>
                            ) : (
                                'Label vorschlagen lassen'
                            )}
                        </button>
                        <label className="row" style={{ gap: 6 }}>
                            <input
                                type="checkbox"
                                checked={allowNew}
                                onChange={(event) => setAllowNew(event.target.checked)}
                            />
                            <span className="faint">
                                Darf ein neues Label vorschlagen, wenn keines passt
                            </span>
                        </label>
                    </div>
                    <p className="faint">
                        Gesendet werden Betreffzeilen und Absender — keine Mailinhalte. Das Modell
                        wählt aus deinen vorhandenen Labels; es entscheidet nicht, was die Regel
                        trifft.
                    </p>
                </>
            )}

            {error !== undefined && (
                <p className="notice notice-danger">
                    Der Vorschlag wurde abgelehnt: {error} — es wurde nichts übernommen.
                </p>
            )}

            {suggestion !== undefined && (
                <div className="notice notice-info">
                    <strong>Vorschlag.</strong> {suggestion.rationale}
                    {suggestion.chosen.length === 0 && suggestion.proposedNew.length === 0 && (
                        <p className="faint" style={{ margin: '8px 0 0' }}>
                            Kein vorhandenes Label passt. Das ist eine gültige Antwort — lieber
                            keines als ein unpassendes.
                        </p>
                    )}
                    {suggestion.chosen.length > 0 && (
                        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                            {suggestion.chosen.map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className="button button-secondary"
                                    disabled={disabled || values.includes(name)}
                                    onClick={() => {
                                        add(name);
                                    }}
                                >
                                    {values.includes(name) ? `${name} ist gewählt` : `${name} übernehmen`}
                                </button>
                            ))}
                        </div>
                    )}
                    {/*
                     * Kept apart, and named as new. Applying one creates something that will still
                     * be in the mailbox in a year, so it is a separate decision from applying a
                     * label that is already there — not one more chip in the same row.
                     */}
                    {suggestion.proposedNew.map((name) => (
                        <p key={name} className="notice notice-warning" style={{ marginTop: 8 }}>
                            <strong>„{name}"</strong> gibt es noch nicht. Es würde zusammen mit der
                            Regel angelegt.
                            <div style={{ marginTop: 8 }}>
                                <button
                                    type="button"
                                    className="button button-secondary"
                                    disabled={disabled || values.includes(name)}
                                    onClick={() => {
                                        add(name);
                                    }}
                                >
                                    Neues Label „{name}" verwenden
                                </button>
                            </div>
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
}
