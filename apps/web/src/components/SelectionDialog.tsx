import { useState } from 'react';

import { createDemoProvider, type RuleProposal } from '@pms/llm';
import { matchesRule, ruleFromCriteria } from '@pms/rules';

import { useMailbox } from '../mailbox.js';
import { MailList, type ListableMessage } from './MailList.js';
import { RuleConditions } from './RuleConditions.js';

/**
 * Building a rule from mail the user picked by hand.
 *
 * For everything the grouping does not catch — and it will not catch everything, because a group
 * that cannot be described by sender, subject or domain has no rule to offer. Here the user says
 * "these belong together" and can add an instruction in their own words, such as asking the model
 * to look for more of the same.
 *
 * The order of operations is the point. The model proposes *criteria*; those criteria are validated
 * against what Proton can express, compiled by our compiler, and then run through the local matcher
 * over the whole mailbox. Only then is anything shown — and what is shown is the real list of
 * affected mail, including the messages the user did not select. A model that widens a rule too far
 * is caught by seeing what it caught, not by trusting its explanation.
 */

const provider = createDemoProvider();

interface Result {
    proposal: RuleProposal;
    rule: ReturnType<typeof ruleFromCriteria>;
    matched: ListableMessage[];
    /** Messages the rule catches that the user did not pick — the interesting ones. */
    additional: ListableMessage[];
    missed: ListableMessage[];
}

export function SelectionDialog({
    selection,
    onClose,
    onOpenMail,
}: {
    selection: ListableMessage[];
    onClose: () => void;
    onOpenMail: (message: ListableMessage) => void;
}): React.JSX.Element {
    const { folders, messages } = useMailbox();
    const [instruction, setInstruction] = useState('');
    const [result, setResult] = useState<Result | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    async function propose(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            const proposal = await provider.proposeRule({
                subjects: selection.map((message) => message.Subject),
                senders: selection.map((message) => message.Sender.Address),
                instruction: instruction.trim(),
                existingFolders: folders.map((folder) => folder.Name),
            });

            const rule = ruleFromCriteria(proposal.criteria, proposal.operator, proposal.folder);

            // The check that makes the model's answer safe to look at: run it over the real
            // mailbox and show what it actually catches.
            const matched = messages.filter((message) => matchesRule(rule.rule, message));
            const selectedIds = new Set(selection.map((message) => message.ID));
            const matchedIds = new Set(matched.map((message) => message.ID));

            setResult({
                proposal,
                rule,
                matched,
                additional: matched.filter((message) => !selectedIds.has(message.ID)),
                missed: selection.filter((message) => !matchedIds.has(message.ID)),
            });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Regel aus Auswahl">
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>Regel aus {selection.length} ausgewählten Mails</h2>
                        <span className="faint">
                            {[...new Set(selection.map((message) => message.Sender.Address))]
                                .slice(0, 3)
                                .join(', ')}
                            {new Set(selection.map((message) => message.Sender.Address)).size > 3 && ' …'}
                        </span>
                    </div>
                    <button type="button" className="button button-quiet" onClick={onClose}>
                        Schliessen
                    </button>
                </header>

                <label className="field">
                    <span>Anweisung ans Modell (optional)</span>
                    <textarea
                        rows={2}
                        value={instruction}
                        placeholder="z. B. es könnte noch ähnliche Mails geben, suche danach"
                        onChange={(event) => setInstruction(event.target.value)}
                    />
                </label>

                <p className="faint">
                    Gesendet werden Betreffzeilen und Absender der ausgewählten Mails — keine
                    Mailinhalte. Modell: {provider.name}.
                </p>

                <div className="row" style={{ marginTop: 12 }}>
                    <button type="button" className="button" onClick={() => void propose()} disabled={busy}>
                        {busy ? 'Frage das Modell…' : 'Regel vorschlagen lassen'}
                    </button>
                </div>

                {error !== undefined && (
                    <p className="notice notice-danger">
                        Der Vorschlag wurde abgelehnt: {error} — nichts wurde übernommen.
                    </p>
                )}

                {result !== undefined && (
                    <section style={{ marginTop: 18 }}>
                        <h3>Vorgeschlagene Regel</h3>
                        <p className="faint">{result.proposal.rationale}</p>
                        <RuleConditions rule={result.rule.rule} />

                        <p className="notice notice-info">
                            Trifft {result.matched.length} Mails im erfassten Zeitraum — davon{' '}
                            {result.additional.length}, die du nicht ausgewählt hattest. Vom Matcher
                            berechnet, nicht vom Modell behauptet.
                        </p>

                        {result.missed.length > 0 && (
                            <p className="notice notice-warning">
                                {result.missed.length} deiner ausgewählten Mails würde die Regel
                                <strong> nicht </strong> treffen. Die Regel ist enger als deine Auswahl.
                            </p>
                        )}

                        {result.additional.length > 0 && (
                            <>
                                <h3 style={{ marginTop: 16 }}>
                                    Zusätzlich betroffen ({result.additional.length})
                                </h3>
                                <p className="faint">
                                    Diese hattest du nicht ausgewählt. Sieh sie an, bevor du die Regel
                                    anlegst — hier zeigt sich, ob sie zu weit greift.
                                </p>
                                <MailList messages={result.additional.slice(0, 12)} onOpen={onOpenMail} />
                            </>
                        )}

                        <div className="row" style={{ marginTop: 16 }}>
                            <button type="button" className="button" onClick={onClose}>
                                Regel vormerken
                            </button>
                            <button type="button" className="button button-secondary" onClick={onClose}>
                                Verwerfen
                            </button>
                        </div>
                        <p className="faint" style={{ marginTop: 8 }}>
                            In der Demo wird nichts geschrieben.
                        </p>
                    </section>
                )}
            </div>
        </div>
    );
}
