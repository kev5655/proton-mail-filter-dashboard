import { useEffect, useState } from 'react';

import { describeChange, describePlan } from '@pms/changes';

import { useAccount } from '../account.js';
import { useStore } from '../store.js';
import { useApply } from '../apply.js';
import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { MailList } from './MailList.js';
import { ProtonSessionHint } from './ProtonSessionHint.js';
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
    const { staged, discard, confirm, settle } = useStore();
    const { source } = useMailboxStatus();
    const { categoryCoverage } = useMailbox();
    const { phase, offer, reset } = useApply();

    /*
     * A finished change closes its own dialog.
     *
     * It used to sit there on a success message until somebody found the „Schliessen" button, which
     * reads as a job that has not finished — and after a folder was created, the folder screen
     * behind it was the thing worth looking at. What the change left behind is not lost: the
     * backup path and any partial result move to the banner in the shell, which stays until it is
     * dismissed.
     */
    /*
     * Whether Proton should also re-file the mail that is already there.
     *
     * It used to be derived — `moves.length > 0` — and then read by nothing: the terminal printed
     * „Bestehende Mail wird mit einbezogen" and no request ever included it. Now it does something,
     * so it has to be a choice rather than an inference. On by default when there is a backlog,
     * because that is what somebody writing a rule about mail they can see in the list below
     * expects; off is a legitimate answer and means „nur für künftige Mail".
     */
    const [applyToExisting, setApplyToExisting] = useState(true);

    const applied = phase.phase === 'applied';
    useEffect(() => {
        if (!applied) {
            return undefined;
        }
        // Now, not on the click. Anything the change decided about a drift entry becomes true at
        // the moment the account says so, and a declined or expired offer settles nothing.
        settle();
        const timer = setTimeout(() => {
            reset();
            discard();
        }, 900);
        return () => {
            clearTimeout(timer);
        };
    }, [applied, reset, discard, settle]);

    if (staged === undefined) {
        return null;
    }

    const { change, moves, clearedFromInbox, returnedToInbox, takenFrom } = staged;
    const rule = change.after ?? change.before;
    // The one change kind that moves mail rather than the rules about it. Several sentences below
    // are written for a filter and would be wrong here — a rule "wirkt erst auf künftige Mail", a
    // move does not.
    const movesMail = change.kind === 'move-to-category';

    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Änderung bestätigen">
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>{describeChange(change)}</h2>
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

                {/*
                  * What Proton already does with this mail.
                  *
                  * The last screen before anything is offered, so this is the placement that
                  * actually counts — the editor's copy of the same sentence can be missed, this one
                  * is between the decision and the account. Stated, never blocking: filing mail into
                  * a folder Proton also categorises is a legitimate thing to want.
                  */}
                {(() => {
                    const dominant = categoryCoverage(moves.map((move) => move.messageId))[0];
                    return dominant === undefined || dominant.count === 0 ? null : (
                        <p className="notice notice-info">
                            <strong>
                                Proton sortiert {dominant.count} dieser {moves.length} Mails schon
                                nach „{dominant.label}".
                            </strong>{' '}
                            {dominant.stable
                                ? 'Bei diesen Absendern jedes Mal, seit wir hinsehen.'
                                : 'Bisher einmal beobachtet.'}
                        </p>
                    );
                })()}

                <h3 style={{ marginTop: 16 }}>Was sich ändert</h3>

                {moves.length === 0 && (
                    <p className="notice notice-warning">
                        {movesMail
                            ? 'Keine der ausgewählten Mails ist in der lokalen Kopie auffindbar. Es würde nichts verschoben.'
                            : 'Keine der erfassten Mails wird dadurch anders einsortiert. Die Regel wirkt erst auf künftige Mail — oder sie greift nicht.'}
                    </p>
                )}

                {/*
                 * Said on the last screen before the offer, not only in the dialog that started it.
                 * Both are open questions about somebody's mailbox, and this is the placement that
                 * is between the decision and the account.
                 */}
                {movesMail && (
                    <p className="notice notice-warning">
                        <strong>Das verschiebt Mail — nicht eine Regel darüber.</strong> Ob die
                        bisherige Kategorie dabei von selbst wegfällt, ist ungeprüft, und ob Proton
                        danach künftige Mail dieser Absender gleich einsortiert, zeigt sich erst über
                        mehrere Synchronisationen. Rückgängig machen legt jede Mail einzeln dorthin
                        zurück, wo sie vorher war.
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
                {phase.phase === 'waiting' && phase.place === 'terminal' && (
                    <div className="notice notice-info">
                        <strong>Warte auf Bestätigung im Terminal.</strong> Dort, wo{' '}
                        <code>pnpm serve</code> läuft, steht jetzt eine Rückfrage
                        {phase.reason === '' ? '' : ` — ${phase.reason}`} Sie zeigt dieselbe
                        Prüfziffer: <code>{phase.shortDigest}</code>. Ohne getipptes „ja" passiert
                        nichts.
                    </div>
                )}

                {phase.phase === 'waiting' && phase.place === 'password' && (
                    <ConfirmWithPassword
                        requestId={phase.requestId}
                        shortDigest={phase.shortDigest}
                        reason={phase.reason}
                    />
                )}

                {phase.phase === 'waiting' && !phase.needsTerminal && (
                    <div className="notice notice-info">
                        <strong>Wird geschrieben.</strong> Diese Änderung ist klein genug, dass die
                        Bestätigung von eben reicht — im Terminal steht keine zweite Frage.
                        Prüfziffer: <code>{phase.shortDigest}</code>.
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
                    <>
                        <div className="notice notice-danger">
                            <strong>
                                Nicht geschrieben{phase.code === undefined ? '' : ` (${phase.code})`}.
                            </strong>{' '}
                            {phase.error}
                        </div>
                        {/* Only when the failure is about the session. Every other error is a
                            different problem, and the same button under all of them would stop
                            meaning anything. */}
                        <ProtonSessionHint code={phase.code} message={phase.error} />
                    </>
                )}

                {/*
                 * Offered only when there is a backlog to act on, and only for a change that has a
                 * filter behind it. Proton applies *its own* rules to the named mail — this tool
                 * still never moves a message itself, which is what keeps the core rule intact
                 * while the backlog gets sorted.
                 */}
                {moves.length > 0 && !movesMail && source !== 'demo' && (
                    <label className="row" style={{ marginTop: 16, gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={applyToExisting}
                            onChange={(event) => setApplyToExisting(event.target.checked)}
                        />
                        <span>
                            Auch die {moves.length} vorhandenen Mails einsortieren lassen. Das macht
                            Proton selbst — wir bitten es nur, seine Filter auf genau diese Mails
                            anzuwenden. Ohne Haken gilt die Regel nur für künftige Mail.
                        </span>
                    </label>
                )}

                <div className="row" style={{ marginTop: 18 }}>
                    {/* Named after its effect. "OK" is what people click without reading. */}
                    <button
                        type="button"
                        className="button"
                        disabled={phase.phase === 'offering' || phase.phase === 'waiting'}
                        aria-busy={phase.phase === 'offering' || phase.phase === 'waiting'}
                        onClick={() => {
                            if (source === 'demo') {
                                // The demo has no account to write to; the local apply is the point.
                                confirm();
                                return;
                            }
                            offer(staged.change, staged, moves.length > 0 && applyToExisting);
                        }}
                    >
                        {/*
                         * A moving thing while nothing else moves. The gap between the click and
                         * the „warte auf das Terminal" notice is two requests long — a fingerprint
                         * and the offer itself — and the button used to sit there disabled with its
                         * ordinary label, which reads as a click that did not register.
                         */}
                        {(phase.phase === 'offering' || phase.phase === 'waiting') && (
                            <span className="spinner" aria-hidden="true" />
                        )}
                        {phase.phase === 'offering'
                            ? 'Wird übermittelt …'
                            : phase.phase === 'waiting'
                            ? phase.place === 'password'
                                ? 'Warte auf dein Passwort …'
                                : 'Warte auf das Terminal …'
                            : movesMail
                              ? `${moves.length} Mails verschieben`
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
                        : /*
                           * No promise about the terminal here. Most changes are confirmed once, in
                           * this dialog; only the expensive ones — a deletion, a change that moves
                           * mail, one that resorts a large share of the mailbox — are asked about
                           * again. Announcing a second question for every change and then not
                           * asking it teaches people to disbelieve the sentence, which is the one
                           * thing it cannot afford.
                           */
                          'Vor dem Schreiben wird eine vollständige Sicherung aller Filter und Ordner angelegt. Beim Löschen wird gleich hier noch einmal nach deinem Passwort gefragt; bei Änderungen, die Mail verschieben, kommt eine Rückfrage im Terminal.'}{' '}
                    Die Änderung lässt sich im Verlauf einzeln rückgängig machen.
                </p>
            </div>
        </div>
    );
}

/**
 * The second confirmation for a deletion, asked here instead of at a terminal.
 *
 * This used to be a typed „ja" in the window where `pnpm serve` runs. That is a stronger gesture in
 * exactly one way — nothing speaking HTTP can produce it — and weaker in every other: it happens in
 * a different window, away from the diff, so the thing being confirmed is not on screen at the
 * moment of confirming. A confirmation performed somewhere else is one people learn to perform
 * without reading.
 *
 * So it moved here, and it kept its teeth by becoming a secret rather than a gesture: the app
 * password, checked by the same `Vault` that holds the key to the mailbox. A wrong one is refused,
 * a slow one is refused by Argon2id being slow, and an installation with no account still gets the
 * terminal, because there the gesture is all there is.
 *
 * The password goes to the account surface and never to `/api/apply` — a `ChangeRequest` is
 * digested, journalled and reported, and nothing that carries a password may end up in a record.
 */
function ConfirmWithPassword({
    requestId,
    shortDigest,
    reason,
}: {
    requestId: string;
    shortDigest: string;
    reason: string;
}): React.JSX.Element {
    const { perform } = useAccount();
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    return (
        <div className="notice notice-warning form-stack">
            <strong>Zum Löschen bitte dein Passwort.</strong>
            <p>
                {reason === '' ? 'Diese Änderung löscht etwas.' : reason} Was oben steht, ist genau
                das, was passiert — es steht hier, damit du es beim Bestätigen noch siehst.
                Prüfziffer: <code>{shortDigest}</code>.
            </p>

            <label className="field field-narrow">
                <span>Passwort</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && password !== '' && !busy) {
                            event.preventDefault();
                            send();
                        }
                    }}
                />
            </label>

            {error !== undefined && <p className="notice notice-danger">{error}</p>}

            <button
                type="button"
                className="button button-danger"
                disabled={password === '' || busy}
                onClick={send}
            >
                {busy ? 'Wird geprüft …' : 'Löschen bestätigen'}
            </button>
        </div>
    );

    function send(): void {
        setError(undefined);
        setBusy(true);
        void perform({ action: 'confirm-change', requestId, password })
            .then(() => {
                setPassword('');
            })
            .catch((cause: Error) => {
                setError(cause.message);
            })
            .finally(() => {
                setBusy(false);
            });
    }
}
