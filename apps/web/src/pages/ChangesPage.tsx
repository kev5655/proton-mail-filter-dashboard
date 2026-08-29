import { useStore } from '../store.js';

/**
 * Rules and folders that appeared at Proton without the tool doing it.
 *
 * The dashboard is not the only way into a mailbox, and pretending otherwise would make it wrong
 * within a week. Anything found here was made in Proton's own interface, and the user decides
 * whether the tool should manage it.
 *
 * Rejecting **disables** rather than deletes. Someone deliberately wrote that rule; losing it to a
 * misclick in a review screen would be a poor trade for tidiness. Deleting is a second, separate
 * decision.
 */
export function ChangesPage(): React.JSX.Element {
    const { drift, resolveDrift } = useStore();
    const open = drift.filter((item) => item.resolved === undefined);

    return (
        <>
            <header className="page-head">
                <h1>Änderungen bei Proton</h1>
                <p>
                    In Protons Oberfläche angelegt, nicht hier. Übernehmen heisst: das Tool verwaltet
                    sie mit. Ablehnen deaktiviert sie bei Proton — gelöscht wird nichts ohne eine
                    zweite, ausdrückliche Entscheidung.
                </p>
            </header>

            {open.length === 0 && <p className="muted">Nichts Neues. Der Stand hier entspricht Proton.</p>}

            {open.map((item) => (
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

                    <p className="notice notice-info">
                        {item.affected === 0
                            ? 'Betrifft keine der erfassten Mails.'
                            : `Betrifft ${item.affected} der erfassten Mails.`}
                    </p>

                    <div className="row" style={{ marginTop: 12 }}>
                        <button type="button" className="button" onClick={() => resolveDrift(item.id, 'adopt')}>
                            Übernehmen
                        </button>
                        <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => resolveDrift(item.id, 'reject')}
                        >
                            Ablehnen (deaktivieren)
                        </button>
                    </div>
                </div>
            ))}

            {drift.some((item) => item.resolved !== undefined) && (
                <p className="notice notice-info">
                    {drift.filter((item) => item.resolved === 'adopt').length} übernommen,{' '}
                    {drift.filter((item) => item.resolved === 'reject').length} deaktiviert. In der
                    Demo wird nichts geschrieben.
                </p>
            )}
        </>
    );
}
