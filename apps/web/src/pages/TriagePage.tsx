import { useState } from 'react';

import type { DemoRule } from '@pms/demo';
import { explainScore } from '@pms/grouping';

import { MailList } from '../components/MailList.js';
import { ScoreBar } from '../components/ScoreBar.js';
import { log } from '../log.js';
import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { protonMailUrl } from '../proton-link.js';
import { useAppState } from '../state.js';
import { useStore } from '../store.js';

/**
 * The screen where inbox clutter turns into rules.
 *
 * Two things are load-bearing here. Every suggestion states *why* the group exists, because a rule
 * the user cannot judge is a rule they should not accept. And nothing is written without a click —
 * accepting only stages the change; the diff and the confirmation come after.
 */
export function TriagePage(): React.JSX.Element {
    const { inboxMessages, suggestions, messagesInGroup, caughtBy } = useMailbox();
    const { source } = useMailboxStatus();
    const { setOpen } = useAppState();

    // Only for the real mailbox: a demo message id points at nothing in anyone's account.
    const linkFor =
        source === 'proton' ? (message: { ID: string; Subject: string }) => protonMailUrl(message) : undefined;
    const { stage, rules } = useStore();
    const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'dismissed'>>({});
    const [openKey, setOpenKey] = useState<string | undefined>(undefined);

    const open = suggestions.filter((entry) => decisions[entry.group.key] === undefined);
    const grouped = suggestions.reduce((total, entry) => total + entry.group.size, 0);

    return (
        <>
            <header className="page-head">
                <h1>Vorschläge</h1>
                <p>
                    {inboxMessages.length} Mails im Posteingang, {grouped} davon in {suggestions.length}{' '}
                    Gruppen. Der Rest sind Einzelfälle und bleibt bewusst ungruppiert — dafür lohnt
                    sich keine Regel.
                </p>
            </header>

            {open.length === 0 && <p className="muted">Alle Vorschläge bearbeitet.</p>}

            {open.map((entry) => {
                const isOpen = openKey === entry.group.key;
                const members = messagesInGroup(entry.group);
                const alreadyCaught = members.filter((message) => caughtBy(message.ID) !== undefined).length;

                /**
                 * What an existing rule already does with this message.
                 *
                 * Two different facts wearing the same badge: filing it where this suggestion
                 * would (neutral — the suggestion is redundant) and filing it somewhere else
                 * (warning — accepting this would change where the mail lands, which is the part
                 * nobody expects).
                 */
                const noteFor = (message: { ID: string }): { text: string; tone: 'neutral' | 'warning'; title: string } | undefined => {
                    const owner = caughtBy(message.ID);
                    if (owner === undefined) {
                        return undefined;
                    }
                    const sameTarget = owner.destination === entry.folder;
                    return {
                        text: sameTarget ? 'schon gefangen' : `→ ${owner.destination}`,
                        tone: sameTarget ? 'neutral' : 'warning',
                        title: sameTarget
                            ? `„${owner.ruleName}" sortiert diese Mail bereits nach „${owner.destination}".`
                            : `„${owner.ruleName}" sortiert diese Mail heute nach „${owner.destination}" — diese Regel würde sie nach „${entry.folder}" umleiten.`,
                    };
                };

                return (
                    <div className="card" key={entry.group.key}>
                        <div className="card-head">
                            <div className="stack">
                                <div className="row">
                                    <strong>{entry.group.reason}</strong>
                                    {entry.group.categories.map((category) => (
                                        <span className="badge badge-neutral" key={category}>
                                            {category}
                                        </span>
                                    ))}
                                </div>
                                <span className="faint">{explainScore(entry.group)}</span>
                            </div>
                            <ScoreBar score={entry.group.score} />
                        </div>

                        <p className="notice notice-info" style={{ marginTop: 12 }}>
                            {entry.explanation}
                        </p>

                        {alreadyCaught > 0 && (
                            // The point of this line: a second rule for mail a first one already
                            // files is not an improvement, it is two rules to keep in step. Said
                            // per card as a count, and per row below as a badge.
                            <p className="notice notice-warning">
                                {alreadyCaught === entry.group.size
                                    ? 'Diese Mails fängt bereits eine bestehende Regel.'
                                    : `${alreadyCaught} der ${entry.group.size} Mails fängt bereits eine bestehende Regel.`}{' '}
                                Dafür braucht es keine zweite.
                            </p>
                        )}

                        {entry.covered < entry.group.size && (
                            <p className="notice notice-warning">
                                Die Regel trifft {entry.covered} der {entry.group.size} Mails dieser
                                Gruppe. Der Rest bleibt liegen.
                            </p>
                        )}

                        {entry.warnings.map((warning) => (
                            <p className="notice notice-danger" key={warning}>
                                {warning}
                            </p>
                        ))}

                        <div className="row" style={{ marginTop: 14 }}>
                            <button
                                type="button"
                                className="button"
                                onClick={() => {
                                    log('info', 'suggestion.stage', {
                                        group: entry.group.kind,
                                        size: entry.group.size,
                                    });
                                    // Built as a named value rather than inline: a rule literal
                                    // passed straight into the change would be checked against the
                                    // narrower OrderedRule and lose `authoredAs`.
                                    const created: DemoRule = {
                                        id: `r-${entry.group.key}`,
                                        name: entry.folder,
                                        priority: rules.length + 1,
                                        enabled: true,
                                        rule: entry.rule,
                                        // Suggested rules are always the clickable kind, so they
                                        // stay editable in Proton's own interface.
                                        authoredAs: 'tree',
                                    };
                                    // Suggested rules go through the same diff as hand-written
                                    // ones. Skipping it for the tool's own proposals would be the
                                    // fastest way to teach someone to click past it.
                                    stage({
                                        id: `create-${entry.group.key}`,
                                        kind: 'create-rule',
                                        summary: `Regel für „${entry.group.reason}" anlegen`,
                                        after: created,
                                    });
                                    setDecisions((current) => ({
                                        ...current,
                                        [entry.group.key]: 'accepted',
                                    }));
                                }}
                            >
                                Regel anlegen
                            </button>
                            <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => setOpenKey(isOpen ? undefined : entry.group.key)}
                            >
                                {isOpen ? 'Mails ausblenden' : `${entry.group.size} Mails ansehen`}
                            </button>
                            <button
                                type="button"
                                className="button button-quiet"
                                onClick={() =>
                                    setDecisions((current) => ({
                                        ...current,
                                        [entry.group.key]: 'dismissed',
                                    }))
                                }
                            >
                                Nicht vorschlagen
                            </button>
                        </div>

                        {isOpen && (
                            // The whole group, not `group.samples` — that holds five, so the
                            // button saying "17 Mails ansehen" showed five of them, and "alle
                            // auswählen" selected five. Both were wrong in the same place.
                            <MailList
                                messages={members}
                                onOpen={setOpen}
                                search
                                selectAll
                                pageSize={10}
                                annotate={noteFor}
                                {...(linkFor === undefined ? {} : { linkFor })}
                            />
                        )}
                    </div>
                );
            })}

            {Object.keys(decisions).length > 0 && (
                <p className="notice notice-info">
                    {Object.values(decisions).filter((value) => value === 'accepted').length} Regeln
                    vorgemerkt. In der Demo wird nichts geschrieben — im echten Betrieb kommt hier der
                    Diff mit den betroffenen Mails und erst danach die Bestätigung.
                </p>
            )}
        </>
    );
}
