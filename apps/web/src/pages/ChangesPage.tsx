import { useMailboxStatus } from '../mailbox.js';
import { useStore } from '../store.js';

/**
 * Rules that appeared at Proton without this tool doing it.
 *
 * The dashboard is not the only way into a mailbox, and pretending otherwise would make it wrong
 * within a week. Anything listed here was written in Proton's own interface — or by anything else
 * with access — and it is running now. The user decides what the tool does about it.
 *
 * Until that decision, the rule is not part of the managed set. It used to simply join the others on
 * „Regeln", which made this screen permanently empty and the sentence above it untrue.
 *
 * All three answers travel the ordinary route: staged, diffed, confirmed. „Übernehmen" writes
 * nothing at all — it records that the rule is ours from now on — but it still shows the diff first,
 * because taking responsibility for a rule without seeing what it catches is not a decision.
 */
export function ChangesPage(): React.JSX.Element {
    const { drift, resolveDrift, rules, stage } = useStore();
    const { source } = useMailboxStatus();
    const open = drift.filter((item) => item.resolved === undefined);

    return (
        <>
            <header className="page-head">
                <h1>Änderungen bei Proton</h1>
                <p>
                    In Protons Oberfläche angelegt, nicht hier. Bis du entscheidest, zählt eine solche
                    Regel nicht zu denen, die dieses Tool verwaltet — sie läuft aber bei Proton
                    weiter. Übernehmen ändert nichts am Konto; Deaktivieren und Löschen schon, und
                    beide zeigen vorher, was sie anrichten.
                </p>
            </header>

            {open.length === 0 && (
                <p className="muted">
                    Nichts Neues. Jede Regel bei Proton ist hier bekannt und wird mitverwaltet.
                </p>
            )}

            {open.map((item) => {
                const rule = rules.find((entry) => entry.id === item.id);

                return (
                    <div className="card" key={item.id}>
                        <div className="card-head">
                            <div className="stack">
                                <div className="row">
                                    <strong>{item.name}</strong>
                                    <span className="badge badge-neutral">
                                        {item.kind === 'rule' ? 'Regel' : 'Ordner'}
                                    </span>
                                </div>
                                <span className="faint">{item.detail}</span>
                            </div>
                        </div>

                        <p className={item.affected === 0 ? 'notice notice-info' : 'notice notice-warning'}>
                            {item.affected === 0
                                ? 'Betrifft keine der erfassten Mails — sie wirkt erst auf künftige.'
                                : `Betrifft ${item.affected} der erfassten Mails.`}
                        </p>

                        <div className="row" style={{ marginTop: 12 }}>
                            <button
                                type="button"
                                className="button"
                                onClick={() => {
                                    if (rule === undefined) {
                                        // A folder, or a rule the copy no longer has. Nothing to
                                        // offer, so the decision is only ours to record.
                                        resolveDrift(item.id, 'adopt');
                                        return;
                                    }
                                    stage(
                                        {
                                            id: `adopt-${item.id}`,
                                            kind: 'adopt-rule',
                                            summary: `Regel „${item.name}" übernehmen`,
                                            before: rule,
                                        },
                                        { id: item.id, decision: 'adopt' }
                                    );
                                }}
                            >
                                Übernehmen
                            </button>

                            <button
                                type="button"
                                className="button button-secondary"
                                disabled={rule === undefined}
                                onClick={() => {
                                    if (rule === undefined) {
                                        return;
                                    }
                                    // Disabling keeps the rule. Someone wrote it deliberately, and
                                    // losing it to a click in a review screen is a poor trade.
                                    stage(
                                        {
                                            id: `disable-${item.id}`,
                                            kind: 'disable-rule',
                                            summary: `Regel „${item.name}" bei Proton deaktivieren`,
                                            before: rule,
                                        },
                                        { id: item.id, decision: 'reject' }
                                    );
                                }}
                            >
                                Deaktivieren
                            </button>

                            <button
                                type="button"
                                className="button button-secondary"
                                disabled={rule === undefined}
                                onClick={() => {
                                    if (rule === undefined) {
                                        return;
                                    }
                                    // Deleting always asks a second time, in the terminal. See
                                    // `weigh` — removals are the one class that never gets waved
                                    // through on the dialog alone.
                                    stage(
                                        {
                                            id: `delete-${item.id}`,
                                            kind: 'delete-rule',
                                            summary: `Regel „${item.name}" bei Proton löschen`,
                                            before: rule,
                                        },
                                        { id: item.id, decision: 'reject' }
                                    );
                                }}
                            >
                                Löschen
                            </button>
                        </div>
                    </div>
                );
            })}

            {drift.some((item) => item.resolved !== undefined) && (
                <p className="notice notice-info">
                    {drift.filter((item) => item.resolved === 'adopt').length} übernommen,{' '}
                    {drift.filter((item) => item.resolved === 'reject').length} abgelehnt.
                    {source === 'demo' && ' In der Demo wird nichts geschrieben.'}
                </p>
            )}
        </>
    );
}
