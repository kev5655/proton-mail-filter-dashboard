import { useState } from 'react';

import { useAccount } from '../account.js';
import { usePower } from '../power.js';

/**
 * Stopping the server from wherever you happen to be.
 *
 * It is the counterpart to the wake screen, and it exists for two reasons that are not electricity.
 * A machine holding a whole mailbox and reachable on a tailnet does not need to be listening on the
 * days nobody uses it; and the sync writes to an SD card every five minutes, which is the main
 * thing wearing that card out. Turning the *machine* off would save power too — this does not, and
 * the confirmation says so rather than letting anyone assume otherwise.
 *
 * Stopping is not disconnecting. `Abmelden` in the settings revokes the Proton session and deletes
 * the local copy; this closes a process and leaves everything on disk exactly where it is.
 *
 * Only offered where there is a starter to talk to, since without one nothing could turn it back on
 * and a stop button would be a way to lock yourself out from a phone.
 */
export function PowerPanel(): React.JSX.Element | null {
    const { served } = useAccount();
    const { state, known, busy, error, stop } = usePower();
    const [asking, setAsking] = useState(false);

    if (!served || !known || state !== 'running') {
        return null;
    }

    return (
        <div className="sync-panel">
            <div className="row">
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                        setAsking(true);
                    }}
                >
                    Server anhalten
                </button>
            </div>
            {error === undefined ? null : <p className="notice notice-danger">{error}</p>}

            {asking ? (
                <ConfirmStop
                    busy={busy}
                    onCancel={() => {
                        setAsking(false);
                    }}
                    onConfirm={() => {
                        void stop()
                            .then(() => {
                                // The page it was serving is gone; what is on screen is now a copy
                                // of something that no longer answers. Reloading lands on the wake
                                // screen, which is the truthful thing to be looking at.
                                window.location.reload();
                            })
                            .catch(() => {
                                setAsking(false);
                            });
                    }}
                />
            ) : null}
        </div>
    );
}

/**
 * The second question, as an overlay rather than a `confirm()`.
 *
 * No password. This reaches nothing at Proton and destroys no data — and `Abmelden`, which revokes
 * the session and deletes the local copy, does not ask for one either. A switch that does less must
 * not demand more. What it does instead is name the consequence, which is the pattern `LockButton`
 * already follows: what happens next belongs on the thing you are about to press.
 */
function ConfirmStop({
    busy,
    onCancel,
    onConfirm,
}: {
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): React.JSX.Element {
    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Server anhalten">
            <div className="viewer">
                <header className="viewer-head">
                    <h2>Server anhalten?</h2>
                    <button type="button" className="button button-quiet" onClick={onCancel}>
                        Abbrechen
                    </button>
                </header>
                <div className="stack" style={{ padding: '16px' }}>
                    <p>
                        Der Dienst hört auf zu laufen. Danach ist dieses Dashboard nicht mehr
                        erreichbar — es zeigt stattdessen einen Knopf zum Starten, von jedem Gerät
                        im Tailnet aus.
                    </p>
                    <ul className="faint">
                        <li>Nichts wird gelöscht. Deine Kopie und dein Konto bleiben, wo sie sind.</li>
                        <li>
                            Die Verbindung zu Proton wird <strong>nicht</strong> abgemeldet — dafür
                            ist „Abmelden" in den Einstellungen da.
                        </li>
                        <li>Bis zum nächsten Start wird nicht synchronisiert.</li>
                        <li>
                            Strom spart es <strong>nicht</strong>: der Rechner läuft weiter, nur
                            dieser Dienst nicht.
                        </li>
                    </ul>
                    <div className="row">
                        <button
                            type="button"
                            className="button button-danger"
                            disabled={busy}
                            onClick={onConfirm}
                        >
                            {busy ? 'Wird angehalten …' : 'Anhalten'}
                        </button>
                        <button type="button" className="button button-quiet" onClick={onCancel}>
                            Abbrechen
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
