import { useStore } from '../store.js';

/**
 * What was done, and the button that takes it back.
 *
 * Undo here is the full one: it removes the rule *and* moves back exactly the messages that rule
 * moved — not everything currently in the folder, which would swallow mail filed there by hand
 * afterwards. That precision is the reason the journal stores a per-message snapshot instead of a
 * description of the change.
 *
 * The verification line is the other half. A write returning success means Proton accepted the
 * filter, not that any mail moved; what is reported here is the result of looking afterwards.
 */
export function HistoryPage(): React.JSX.Element {
    const { journal, undo } = useStore();

    return (
        <>
            <header className="page-head">
                <h1>Verlauf</h1>
                <p>
                    Jede Änderung einzeln rückgängig zu machen — inklusive der Mails, die sie
                    verschoben hat. Zusätzlich liegt vor jedem Schreibzugriff eine vollständige
                    Sicherung aller Filter und Ordner.
                </p>
            </header>

            {journal.length === 0 && (
                <p className="muted">Noch nichts geändert. Was du bestätigst, erscheint hier.</p>
            )}

            {journal.map((entry) => (
                <div className="card" key={entry.id}>
                    <div className="card-head">
                        <div className="stack">
                            <div className="row">
                                <strong>{entry.change.summary}</strong>
                                {entry.undoneAt !== undefined && (
                                    <span className="badge badge-neutral">rückgängig gemacht</span>
                                )}
                            </div>
                            <span className="faint">
                                {new Date(entry.at).toLocaleString('de-CH')} · {entry.moved.length} Mails
                                betroffen
                            </span>
                        </div>

                        {entry.undoneAt === undefined && (
                            <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => undo(entry.id)}
                            >
                                Rückgängig
                            </button>
                        )}
                    </div>

                    {entry.verification !== undefined && (
                        <p
                            className={
                                entry.verification.stragglers.length === 0
                                    ? 'notice notice-info'
                                    : 'notice notice-danger'
                            }
                        >
                            {entry.verification.stragglers.length === 0
                                ? `Nachgeprüft: alle ${entry.verification.confirmed} Mails sind tatsächlich verschoben.`
                                : `Nachgeprüft: nur ${entry.verification.confirmed} von ${
                                      entry.verification.confirmed + entry.verification.stragglers.length
                                  } Mails sind verschoben. ${entry.verification.stragglers.length} liegen noch, wo sie waren.`}
                        </p>
                    )}

                    {entry.undoneAt === undefined && entry.moved.length > 0 && (
                        <p className="faint">
                            Rückgängig macht die Regel weg und holt genau diese {entry.moved.length}{' '}
                            Mails zurück — keine anderen.
                        </p>
                    )}
                </div>
            ))}
        </>
    );
}
