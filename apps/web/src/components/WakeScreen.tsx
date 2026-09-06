import { useState } from 'react';

import { usePower } from '../power.js';

/**
 * What you see when the machine is there but the service is not running.
 *
 * The page itself comes from the service worker's cache — the server that normally serves it is the
 * one that is stopped — and the button talks to a small program on the host, published under the
 * same name at `/starter`. Same origin, so no browser is asked to make an exception for this.
 *
 * **Starting grants nothing**, and the screen says so rather than leaving it to be discovered. The
 * server comes up locked: the key is not in it, the database is not open, and the next screen is
 * the password. Somebody who wakes this has not thereby opened anything.
 *
 * It does not poll on a timer while it waits. Starting is a deliberate act with a visible result,
 * and a screen that quietly rechecks in the background is one that changes under you.
 */
export function WakeScreen(): React.JSX.Element {
    const { start, recheck, busy, error } = usePower();
    const [started, setStarted] = useState(false);

    return (
        <div className="lock-screen">
            <div className="lock-card">
                <div className="lock-mark" aria-hidden="true">
                    <svg
                        viewBox="0 0 24 24"
                        width="28"
                        height="28"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                    >
                        <path d="M12 3v9" />
                        <path d="M6.8 6.8a8 8 0 1 0 10.4 0" />
                    </svg>
                </div>

                <div className="stack">
                    <h1>Der Server ist angehalten</h1>
                    {started ? (
                        <>
                            <p className="faint">
                                Er startet. Das dauert auf dem Raspberry Pi eine Weile — die Seite
                                lädt nicht von selbst neu.
                            </p>
                            <button
                                type="button"
                                className="button"
                                disabled={busy}
                                onClick={() => {
                                    recheck();
                                    window.location.reload();
                                }}
                            >
                                {busy ? 'Wird geprüft …' : 'Nachsehen'}
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="faint">
                                Die Maschine läuft, der Dienst nicht. Starten kostet nichts und gibt
                                nichts frei: er kommt gesperrt hoch, ohne Schlüssel und ohne
                                geöffnete Kopie deines Postfachs. Danach fragt er nach dem Passwort.
                            </p>
                            <button
                                type="button"
                                className="button"
                                disabled={busy}
                                onClick={() => {
                                    void start()
                                        .then(() => {
                                            setStarted(true);
                                        })
                                        .catch(() => {
                                            // Shown below from the provider's own message.
                                        });
                                }}
                            >
                                {busy ? 'Wird gestartet …' : 'Server starten'}
                            </button>
                        </>
                    )}

                    {error === undefined ? null : (
                        <p className="notice notice-danger">{error}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
