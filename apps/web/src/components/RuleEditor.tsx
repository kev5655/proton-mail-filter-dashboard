import { useDeferredValue, useMemo, useState } from 'react';

import type { MailboxMessage, MailboxRule } from '@pms/server/types';
import { FilterStatement } from '@proton/sieve/filterModel';

import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { useSettings } from '../llm.js';
import { LabelPicker } from './LabelPicker.js';
import { protonMailUrl } from '../proton-link.js';
import {
    emptyCondition,
    isDirty,
    isExpressibleAsTree,
    toSimpleObject,
    validateDraft,
    type DraftCondition,
    type RuleDraft,
} from '../rules/draft.js';
import { STATEMENTS } from '../rules/labels.js';
import { buildIndex, diffAgainst, evaluateDraft, messagesOf } from '../rules/preview.js';
import { ConditionEditor } from './ConditionEditor.js';
import { MailList, type MailNote } from './MailList.js';
import { SieveDetail } from './SieveDetail.js';

/**
 * Editing a rule in place, with its consequences visible while it is edited.
 *
 * Four sections, all on screen at once and in Proton's own order — Name, Bedingungen, Aktionen,
 * Vorschau — because a rule is short enough to see whole, and a wizard that shows one step at a
 * time hides the relationship between the conditions and what they catch. That relationship is the
 * only thing worth looking at.
 *
 * The preview is two columns, and the right-hand one is deliberately not "everything else". The
 * complement of a rule over thirteen thousand messages is thirteen thousand rows that say nothing;
 * what is worth seeing is mail from the *same senders and domains* that the rule misses, because
 * that is where a rule is usually too narrow. The switch to the full complement is there, labelled,
 * and off by default.
 *
 * Nothing here writes. Saving stages a change, and the diff and the confirmation come after — the
 * same route as every other change, including the ones the tool proposed itself.
 */

export function RuleEditor({
    draft,
    original,
    savedRule,
    onChange,
    onSave,
    onCancel,
    onOpenMail,
}: {
    draft: RuleDraft;
    /** The draft as it was opened, for "is this changed" and for the +N / −N line. */
    original: RuleDraft;
    /** The rule as stored, absent when creating. Used to decide whether conversion is needed. */
    savedRule: MailboxRule | undefined;
    onChange: (next: RuleDraft) => void;
    onSave: () => void;
    onCancel: () => void;
    onOpenMail: (message: MailboxMessage) => void;
}): React.JSX.Element {
    const { messages, folders, labels, caughtBy, categoryCoverage } = useMailbox();
    const settings = useSettings();
    const { source } = useMailboxStatus();
    const [showAllOthers, setShowAllOthers] = useState(false);
    const [showSieve, setShowSieve] = useState(false);

    const index = useMemo(() => buildIndex(messages), [messages]);

    // The rule changes when a condition changes, not when a name does. Deferring the key keeps
    // typing responsive without the preview lagging behind a committed value.
    const previewKey = useDeferredValue(
        `${draft.operator}|${draft.conditions.map((c) => `${c.type} ${c.comparator} ${c.values.join(' ')}`).join('|')}`
    );

    const preview = useMemo(
        () => evaluateDraft(index, draft),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey is the rule's identity
        [index, previewKey]
    );

    const savedPreview = useMemo(
        () => (savedRule === undefined ? undefined : evaluateDraft(index, original)),
        [index, original, savedRule]
    );

    const problems = validateDraft(draft, folders, labels);
    const blocking = problems.filter((problem) => problem.level === 'error');
    const general = problems.filter((problem) => problem.uid === undefined);

    const warnedValues = useMemo(() => {
        const byCondition = new Map<string, Set<string>>();
        for (const problem of problems) {
            if (problem.uid === undefined) {
                continue;
            }
            const condition = draft.conditions.find((entry) => entry.uid === problem.uid);
            for (const value of condition?.values ?? []) {
                if (problem.message.includes(`„${value}"`)) {
                    const set = byCondition.get(problem.uid) ?? new Set<string>();
                    set.add(value);
                    byCondition.set(problem.uid, set);
                }
            }
        }
        return byCondition;
    }, [problems, draft.conditions]);

    const matched = useMemo(() => messagesOf(index, preview.matched, 1), [index, preview]);

    /**
     * The mail this rule does *not* catch, narrowed to what is worth looking at.
     *
     * Same senders and same domains as the matched set: that is where the answer to "why did it
     * miss that one" lives. Everything else is the rest of the mailbox.
     */
    const others = useMemo(() => {
        const all = messagesOf(index, preview.matched, 0);
        if (showAllOthers) {
            return all;
        }
        const senders = new Set(matched.map((message) => message.Sender.Address.toLowerCase()));
        const domains = new Set(
            matched.map((message) => message.Sender.Address.toLowerCase().split('@')[1] ?? '')
        );
        return all.filter((message) => {
            const address = message.Sender.Address.toLowerCase();
            return senders.has(address) || domains.has(address.split('@')[1] ?? '');
        });
    }, [index, preview, matched, showAllOthers]);

    const difference = savedPreview === undefined ? undefined : diffAgainst(savedPreview.matched, preview.matched);
    const alreadyCaught = matched.filter((message) => {
        const owner = caughtBy(message.ID);
        return owner !== undefined && owner.ruleId !== draft.ruleId;
    }).length;

    /*
     * How much of this rule's catch Proton already sorts.
     *
     * The earliest point at which changing your mind is still cheap: the rule has not been written,
     * nothing has been offered, and the question "does this duplicate work Proton already does" is
     * answerable. Shown as a fact, never as a block — a category and a folder are not the same
     * thing, and wanting both is legitimate.
     */
    const coverage = categoryCoverage(matched.map((message) => message.ID));
    const dominant = coverage[0];

    /*
     * Two different questions, and conflating them kept the notice on screen after the user had
     * already acted on it.
     *
     * `authoredAs` describes the *saved* rule and does not change until a new version is written to
     * Proton — so deriving the notice from it alone meant "In einen Proton-Filter umwandeln" left
     * everything exactly as it was, minus the lock. `stillSieve` is the narrower question the
     * notice is actually about: is this rule still presented as a script *right now*.
     */
    const savedAsSieve = savedRule?.authoredAs === 'sieve';
    const verdict = savedRule === undefined ? { expressible: true as const } : isExpressibleAsTree(savedRule.rule);
    const stillSieve = savedAsSieve && !showSieve;
    const locked = stillSieve;

    const linkFor =
        source === 'proton'
            ? (message: { ID: string; Subject: string }) => protonMailUrl(message, settings.proton)
            : undefined;

    const noteFor = (message: { ID: string }): MailNote | undefined => {
        const owner = caughtBy(message.ID);
        if (owner === undefined || owner.ruleId === draft.ruleId) {
            return undefined;
        }
        return {
            text: `→ ${owner.destination}`,
            tone: owner.destination === draft.folder ? 'neutral' : 'warning',
            title: `Heute entscheidet „${owner.ruleName}" über diese Mail: nach „${owner.destination}".`,
        };
    };

    const setCondition = (uid: string, next: DraftCondition): void => {
        onChange({
            ...draft,
            conditions: draft.conditions.map((condition) => (condition.uid === uid ? next : condition)),
        });
    };

    return (
        <div className="rule-editor">
            <header className="card-head">
                <h2>{draft.ruleId === undefined ? 'Neue Regel' : draft.name || 'Ohne Namen'}</h2>
                {isDirty(original, draft) && <span className="badge badge-warning">Nicht gespeichert</span>}
            </header>

            {/*
             * Converted, but not yet saved. Said plainly, because the rule at Proton is still the
             * script until somebody stages and confirms the change — and a screen that simply went
             * quiet here would suggest the conversion had already landed.
             */}
            {savedAsSieve && !stillSieve && (
                <div className="notice notice-info">
                    <strong>Umgewandelt.</strong> Die Felder unten sind jetzt bearbeitbar. Bei Proton
                    steht weiterhin das Sieve-Skript — erst <em>Vormerken</em> und die Bestätigung
                    machen daraus einen klickbaren Filter.
                </div>
            )}

            {/*
             * Switched off at Proton. Worth its own line rather than a badge: every count and every
             * preview below assumes the rule runs, and none of them does while it is off.
             */}
            {savedRule !== undefined && !savedRule.enabled && (
                <div className="notice notice-warning">
                    <strong>Diese Regel ist bei Proton deaktiviert.</strong> Sie läuft nicht, und die
                    Vorschau unten zeigt, was sie <em>täte</em>, wenn sie liefe — nicht, was gerade
                    passiert.
                </div>
            )}

            {stillSieve && (
                <div className="notice notice-warning">
                    <strong>Diese Regel ist als Sieve-Skript geschrieben.</strong> Protons eigene
                    Oberfläche kann sie deshalb nicht mehr bearbeiten, und dieser Editor
                    standardmässig auch nicht.{' '}
                    {verdict.expressible ? (
                        <>
                            Sie liesse sich aber vollständig als klickbarer Filter ausdrücken. Beim
                            Umwandeln siehst du vorher, was sich dadurch an den getroffenen Mails
                            ändert.
                            <div style={{ marginTop: 8 }}>
                                <button
                                    type="button"
                                    className="button button-secondary"
                                    onClick={() => setShowSieve(true)}
                                >
                                    In einen Proton-Filter umwandeln
                                </button>
                            </div>
                        </>
                    ) : (
                        <>Umwandeln geht hier nicht: {verdict.reason}</>
                    )}
                </div>
            )}

            <section className="editor-section">
                <h3>Name</h3>
                <input
                    type="text"
                    className="text-input"
                    value={draft.name}
                    disabled={locked}
                    placeholder="Wofür ist diese Regel da?"
                    onChange={(event) => onChange({ ...draft, name: event.target.value })}
                    aria-label="Name der Regel"
                />
            </section>

            <section className="editor-section">
                <h3>Bedingungen</h3>

                <div className="statement-choice">
                    {STATEMENTS.map((statement) => (
                        <label key={statement.value} className="radio-row">
                            <input
                                type="radio"
                                name="statement"
                                checked={draft.operator === statement.value}
                                disabled={locked}
                                onChange={() => onChange({ ...draft, operator: statement.value })}
                            />
                            <strong>{statement.label}</strong>
                            <span className="faint">({statement.hint})</span>
                        </label>
                    ))}
                </div>

                <fieldset disabled={locked} className="bare-fieldset">
                    {draft.conditions.map((condition, position) => (
                        <ConditionEditor
                            key={condition.uid}
                            condition={condition}
                            index={position}
                            total={draft.conditions.length}
                            warnedValues={warnedValues.get(condition.uid) ?? new Set()}
                            problems={problems
                                .filter((problem) => problem.uid === condition.uid)
                                .map((problem) => ({ level: problem.level, message: problem.message }))}
                            onChange={(next) => setCondition(condition.uid, next)}
                            onRemove={() =>
                                onChange({
                                    ...draft,
                                    conditions: draft.conditions.filter((entry) => entry.uid !== condition.uid),
                                })
                            }
                        />
                    ))}

                    <button
                        type="button"
                        className="button button-quiet"
                        onClick={() => onChange({ ...draft, conditions: [...draft.conditions, emptyCondition()] })}
                    >
                        Bedingung hinzufügen
                    </button>
                </fieldset>

                <p className="faint" style={{ marginTop: 8 }}>
                    Mehr Felder gibt es nicht: Protons Filter kennen Absender, Betreff, Empfänger und
                    Anhang. Auf den Inhalt einer Mail kann eine Regel nicht zugreifen.
                </p>
            </section>

            <section className="editor-section">
                <h3>Aktionen</h3>
                <div className="row">
                    <label className="stack">
                        {/*
                 * Move or mark, and it is a real difference rather than a wording one.
                 *
                 * Proton's filter model has no label action — the name goes into `FileInto` either
                 * way and Proton resolves it against whichever object carries it. What this choice
                 * decides is what the preview predicts, and what gets *created* when the name is
                 * new: without it, typing a new label name silently produced a folder.
                 */}
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                    <button
                        type="button"
                        className={draft.targetKind === 'folder' ? 'button' : 'button button-quiet'}
                        aria-pressed={draft.targetKind === 'folder'}
                        // The name goes too. A folder and a label are different objects with
                        // different lists, and a name typed for one is almost never the name
                        // wanted for the other — carrying it over produced a rule pointing at a
                        // label that did not exist, ready to create it.
                        onClick={() => onChange({ ...draft, targetKind: 'folder', folder: '' })}
                    >
                        In einen Ordner verschieben
                    </button>
                    <button
                        type="button"
                        className={draft.targetKind === 'label' ? 'button' : 'button button-quiet'}
                        aria-pressed={draft.targetKind === 'label'}
                        onClick={() => onChange({ ...draft, targetKind: 'label', folder: '' })}
                    >
                        Mit einem Label markieren
                    </button>
                </div>

                <p className="faint" style={{ marginBottom: 8 }}>
                    {draft.targetKind === 'folder'
                        ? 'Die Mail verlässt den Posteingang und liegt danach im Ordner.'
                        : 'Die Mail bleibt im Posteingang und trägt zusätzlich das Label.'}
                </p>

                <span className="faint">{draft.targetKind === 'folder' ? 'Verschieben nach' : 'Markieren mit'}</span>
                        <input
                            type="text"
                            className="text-input"
                            list="folder-names"
                            value={draft.folder}
                            disabled={locked}
                            placeholder="Ordnername"
                            onChange={(event) => onChange({ ...draft, folder: event.target.value })}
                            aria-label="Zielordner"
                        />
                        {draft.targetKind === 'label' && (
                    <div style={{ marginTop: 12 }}>
                        <LabelPicker
                            labels={labels}
                            value={draft.folder}
                            subjects={matched.map((message) => message.Subject)}
                            senders={matched.map((message) => message.Sender.Address)}
                            onPick={(name) => onChange({ ...draft, folder: name })}
                        />
                    </div>
                )}

                <datalist id="folder-names">
                            {folders.map((folder) => (
                                <option key={folder.ID} value={folder.Name} />
                            ))}
                        </datalist>
                    </label>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                    <label className="radio-row">
                        <input
                            type="checkbox"
                            checked={draft.markRead}
                            disabled={locked}
                            onChange={(event) => onChange({ ...draft, markRead: event.target.checked })}
                        />
                        Als gelesen markieren
                    </label>
                    <label className="radio-row">
                        <input
                            type="checkbox"
                            checked={draft.markStarred}
                            disabled={locked}
                            onChange={(event) => onChange({ ...draft, markStarred: event.target.checked })}
                        />
                        Mit Stern markieren
                    </label>
                </div>
            </section>

            {general.map((problem) => (
                <p
                    key={problem.message}
                    className={problem.level === 'error' ? 'notice notice-danger' : 'notice notice-warning'}
                >
                    {problem.message}
                </p>
            ))}

            <section className="editor-section">
                <h3>Vorschau</h3>
                <p className="faint">
                    Trifft {preview.count} {preview.count === 1 ? 'Mail' : 'Mails'}
                    {alreadyCaught > 0 && <> · {alreadyCaught} davon entscheidet heute eine andere Regel</>}
                    {difference !== undefined && (difference.added > 0 || difference.removed > 0) && (
                        <>
                            {' '}
                            · <strong>+{difference.added}</strong> / <strong>−{difference.removed}</strong>{' '}
                            gegenüber der gespeicherten Regel
                        </>
                    )}
                </p>

                {dominant !== undefined && dominant.count > 0 && (
                    <p className="notice notice-info">
                        <strong>
                            Proton sortiert {dominant.count} dieser {matched.length} Mails schon nach
                            „{dominant.label}".
                        </strong>{' '}
                        {dominant.stable
                            ? 'Und tut das bei diesen Absendern jedes Mal, seit wir hinsehen.'
                            : 'Beobachtet allerdings erst einmal — das kann ein Zufall des letzten Syncs sein.'}{' '}
                        Ein eigener Ordner ist trotzdem sinnvoll, wenn du die Mail dauerhaft
                        woanders haben willst; doppelt ist nur die Sortierarbeit.
                    </p>
                )}

                <div className="split">
                    <div className="preview-column">
                        <div className="preview-head">
                            <h4>Wird getroffen ({matched.length})</h4>
                            <p className="faint">Alles, was diese Regel im erfassten Zeitraum einsammelt.</p>
                        </div>
                        <MailList
                            messages={matched}
                            onOpen={onOpenMail as (message: { ID: string }) => void}
                            search
                            pageSize={settings.display.pageSize}
                            selectable={false}
                            annotate={noteFor}
                            emptyText="Noch nichts — die Regel trifft im erfassten Zeitraum keine Mail."
                            {...(linkFor === undefined ? {} : { linkFor })}
                        />
                    </div>
                    <div className="preview-column">
                        {/*
                         * Same structure as the left column — heading, one line, then the list — so
                         * the two search boxes line up. They did not: the toggle and a two-line
                         * explanation pushed this one down by exactly its own height.
                         */}
                        <div className="preview-head">
                            <h4>
                                Wird nicht getroffen ({others.length})
                                <button
                                    type="button"
                                    className="value-chip value-chip-link"
                                    onClick={() => setShowAllOthers(!showAllOthers)}
                                >
                                    {showAllOthers ? 'nur verwandte zeigen' : 'alle übrigen zeigen'}
                                </button>
                            </h4>
                            <p className="faint">
                                {showAllOthers
                                    ? 'Alle übrigen Mails im erfassten Zeitraum.'
                                    : 'Nur dieselben Absender und Domänen — dort sitzt eine zu enge Regel.'}
                            </p>
                        </div>
                        <MailList
                            messages={others}
                            onOpen={onOpenMail as (message: { ID: string }) => void}
                            search
                            pageSize={settings.display.pageSize}
                            selectable={false}
                            annotate={noteFor}
                            emptyText="Nichts Verwandtes, das die Regel verfehlt."
                            {...(linkFor === undefined ? {} : { linkFor })}
                        />
                    </div>
                </div>
            </section>

            <details className="editor-section">
                <summary>Erweitert — das kompilierte Sieve-Skript</summary>
                <p className="faint">
                    Was Proton am Ende ausführt, erzeugt aus der Regel oben. Nur zum Nachsehen; eine
                    Regel als Skript zu schreiben nimmt Protons eigener Oberfläche die Möglichkeit,
                    sie je wieder zu bearbeiten.
                </p>
                <pre className="sieve-code">{JSON.stringify(toSimpleObject(draft), null, 2)}</pre>

                {/* For a rule that was written as Sieve, what Proton actually stores — and a
                    model's reading of it, labelled and below the derived structure, never instead
                    of it. */}
                {savedAsSieve && savedRule !== undefined && <SieveDetail ruleId={savedRule.id} />}
            </details>

            <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="button" disabled={blocking.length > 0} onClick={onSave}>
                    {draft.ruleId === undefined ? 'Regel vormerken' : 'Änderung vormerken'}
                </button>
                <button type="button" className="button button-quiet" onClick={onCancel}>
                    Verwerfen
                </button>
                {blocking.length > 0 && (
                    <span className="faint">{blocking.length} offene Punkte oben.</span>
                )}
            </div>

            <p className="faint" style={{ marginTop: 8 }}>
                Vormerken schreibt noch nichts. Danach kommt der Diff mit den Folgen, dann die
                Bestätigung.
            </p>
        </div>
    );
}

/** Proton's own default when nothing else is known. Exported so the page and the editor agree. */
export const DEFAULT_STATEMENT = FilterStatement.ALL;
