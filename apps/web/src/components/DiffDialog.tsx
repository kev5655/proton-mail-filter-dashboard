import { describePlan } from '@pms/changes';

import { useStore } from '../store.js';
import { useApply } from '../apply.js';
import { useMailboxStatus } from '../mailbox.js';
import { MailList } from './MailList.js';
import { RuleConditions } from './RuleConditions.js';

/**
 * The last thing between a decision and someone's mailbox.
 *
 * It shows consequences rather than intentions. The rule text says what the rule looks for; this
 * says which messages move, where they move from, and — the part that is easy to miss — which
 * *other* rule was quietly handling them until now. Adding a rule that steals mail from an existing
 * one is not visible anywhere else.
 *
 * The confirming button says what will happen, not "OK". A dialog whose action is unnamed is a
 * dialog people learn to dismiss.
 */
export function DiffDialog({ onOpenMail }: { onOpenMail: (message: never) => void }): React.JSX.Element | null {
    const { staged, discard, confirm } = useStore();
    const { source } = useMailboxStatus();
    const { phase, offer, reset } = useApply();

    if (staged === undefined) {
        return null;
    }

    const { change, moves, clearedFromInbox, returnedToInbox, takenFrom } = staged;
    const rule = change.after ?? change.before;

    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Änderung bestätigen">
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>{change.summary}</h2>
                        <span className="faint">{describePlan(staged)}</span>
                    </div>
                    <button type="button" className="button button-quiet" onClick={discard}>
                        Abbrechen
                    </button>
                </header>

                {rule !== undefined && change.kind !== 'delete-rule' && (
                    <>
                        <h3>Die Regel</h3>
                        <RuleConditions rule={rule.rule} />
                    </>
                )}

                {change.kind === 'delete-rule' && rule !== undefined && (
                    <>
                        <h3>Wird gelöscht</h3>
                        <RuleConditions rule={rule.rule} />
                    </>
                )}

                <h3 style={{ marginTop: 16 }}>Was sich ändert</h3>

                {moves.length === 0 && (
                    <p className="notice notice-warning">
                        Keine der erfassten Mails wird dadurch anders einsortiert. Die Regel wirkt erst
                        auf künftige Mail — oder sie greift nicht.
                    </p>
                )}

                {clearedFromInbox > 0 && (
                    <p className="notice notice-info">
                        {clearedFromInbox} Mails verlassen den Posteingang.
                    </p>
                )}

                {returnedToInbox > 0 && (
                    <p className="notice notice-warning">
                        {returnedToInbox} Mails kommen in den Posteingang zurück.
                    </p>
                )}

                {takenFrom.map((entry) => (
                    <p className="notice notice-warning" key={entry.ruleName}>
                        {entry.count} Mails werden „{entry.ruleName}" weggenommen — bisher hat diese
                        Regel entschieden, wohin sie gehen.
                    </p>
                ))}

                {moves.length > 0 && (
                    <table className="diff-table">
                        <thead>
                            <tr>
                                <th>Mail</th>
                                <th>bisher</th>
                                <th>danach</th>
                            </tr>
                        </thead>
                        <tbody>
                            {moves.slice(0, 15).map((move) => (
                                <tr key={move.messageId}>
                                    <td>
                                        <span className="mail-subject">{move.subject}</span>
                                        <span className="mail-sender">{move.sender}</span>
                                    </td>
                                    <td className="faint">{move.from ?? 'Posteingang'}</td>
                                    <td>
                                        <code className="value-chip">{move.to ?? 'Posteingang'}</code>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {moves.length > 15 && (
                    <p className="faint">… und {moves.length - 15} weitere.</p>
                )}

                {/*
                 * Waiting, and saying where.
                 *
                 * Clicking here does not write. It offers the change to the process holding the
                 * Proton session, which prints it in its terminal and waits for a typed „ja". The
                 * six characters shown here are the same ones printed there — if they differ, the
                 * terminal is asking about something other than what is on this screen.
                 */}
                {phase.phase === 'waiting' && (
                    <div className="notice notice-info">
                        <strong>Warte auf Bestätigung im Terminal.</strong> Dort, wo{' '}
                        <code>pnpm serve</code> läuft, steht jetzt eine Rückfrage. Sie zeigt dieselbe
                        Prüfziffer: <code>{phase.shortDigest}</code>. Ohne getipptes „ja" passiert
                        nichts.
                    </div>
                )}

                {phase.phase === 'applied' && (
                    <div className="notice notice-info">
                        <strong>Bei Proton gespeichert.</strong> Sicherung liegt unter{' '}
                        <code>{phase.backupPath}</code>.
                        {phase.partial !== undefined && (
                            <>
                                <br />
                                <br />
                                <strong>Nicht vollständig:</strong> {phase.partial}
                            </>
                        )}
                    </div>
                )}

                {phase.phase === 'failed' && (
                    <div className="notice notice-danger">
                        <strong>Nicht geschrieben{phase.code === undefined ? '' : ` (${phase.code})`}.</strong>{' '}
                        {phase.error}
                    </div>
                )}

                <div className="row" style={{ marginTop: 18 }}>
                    {/* Named after its effect. "OK" is what people click without reading. */}
                    <button
                        type="button"
                        className="button"
                        disabled={phase.phase === 'offering' || phase.phase === 'waiting'}
                        onClick={() => {
                            if (source === 'demo') {
                                // The demo has no account to write to; the local apply is the point.
                                confirm();
                                return;
                            }
                            offer(staged.change, staged, moves.length > 0);
                        }}
                    >
                        {phase.phase === 'waiting'
                            ? 'Warte auf das Terminal …'
                            : moves.length > 0
                              ? `Bei Proton speichern und ${moves.length} Mails einsortieren`
                              : 'Bei Proton speichern'}
                    </button>
                    <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => {
                            reset();
                            discard();
                        }}
                    >
                        {phase.phase === 'applied' ? 'Schliessen' : 'Abbrechen'}
                    </button>
                </div>

                <p className="faint" style={{ marginTop: 8 }}>
                    {source === 'demo'
                        ? 'Demo-Daten: es wird nichts geschrieben, die Änderung wirkt nur hier.'
                        : 'Vor dem Schreiben wird eine vollständige Sicherung aller Filter und Ordner angelegt. Die Rückfrage kommt im Terminal, nicht hier.'}{' '}
                    Die Änderung lässt sich im Verlauf einzeln rückgängig machen.
                </p>
            </div>
        </div>
    );
}
