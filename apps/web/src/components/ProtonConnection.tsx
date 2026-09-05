import { useState } from 'react';

import { useLogin } from '../login.js';

/**
 * Cutting the connection to Proton, and everything that goes with it.
 *
 * It lives in the settings rather than the sidebar because of what it removes: the stored session
 * *and* the local copy of the mailbox — every folder, rule and message the tool has cached, plus
 * the backups of the filters. That is the point, as asked for: after disconnecting, nothing about
 * this mailbox should be left on the machine for whoever uses it next. It is also irreversible in
 * the one direction that matters, so it does not belong one click away from every screen.
 *
 * Two buttons, because there are two different acts and only one of them can fail. Forgetting
 * locally always works. Revoking is a single request to Proton, and if it does not land the token
 * stays alive — which is exactly the state we were in before pressing anything. Saying „überall
 * abgemeldet" when only this machine forgot is the one lie this screen cannot afford, so what
 * actually happened is reported afterwards rather than assumed.
 */
export function ProtonConnection(): React.JSX.Element | null {
    const { status, connected, disconnect, refusal } = useLogin();
    const [confirming, setConfirming] = useState<'local' | 'everywhere' | undefined>(undefined);

    if (!connected || !status.available) {
        return null;
    }

    const busy = status.state === 'disconnecting';

    return (
        <div className="card">
            <h2>Verbindung zu Proton</h2>

            {status.state === 'disconnected' ? (
                <>
                    <p className="notice notice-info">
                        <strong>Getrennt.</strong>{' '}
                        {status.revoked
                            ? 'Die Sitzung wurde auch bei Proton beendet.'
                            : 'Die Sitzung wurde hier vergessen. Bei Proton bleibt sie bestehen, bis sie abläuft — beenden lässt sie sich dort unter „Sitzungen".'}{' '}
                        Die lokale Kopie ist gelöscht.
                    </p>
                    {status.revokeError !== undefined && (
                        <p className="notice notice-warning">
                            <strong>Bei Proton abmelden hat nicht geklappt:</strong>{' '}
                            {status.revokeError} Lokal ist trotzdem alles weg. Die Sitzung lässt sich
                            in Protons Einstellungen unter „Sitzungen" von Hand beenden.
                        </p>
                    )}
                    <p className="faint">
                        Dieser Server beendet sich gleich — es gibt nichts mehr zu bedienen. Zum
                        Weiterarbeiten <code>pnpm serve</code> neu starten und im Dashboard neu
                        verbinden.
                    </p>
                </>
            ) : (
                <>
                    <p className="faint">
                        {status.signedIn
                            ? 'Dieses Werkzeug hält eine Sitzung zu deinem Konto.'
                            : 'Zurzeit besteht keine Sitzung.'}
                    </p>

                    {/*
                     * Said before the button, not after it. The mailbox copy is the thing people do
                     * not expect to lose, and the backups are the only way to restore a filter
                     * somebody deleted — both are gone, and both are the point.
                     */}
                    <p className="notice notice-warning">
                        <strong>Trennen löscht die lokale Kopie.</strong> Ordner, Regeln, erfasste
                        Mail-Kopfdaten, der Verlauf und die Sicherungen deiner Filter — alles weg,
                        damit nichts über dein Postfach auf diesem Rechner liegen bleibt. Beim
                        nächsten Verbinden dauert der erste Sync wieder ein paar Minuten. Dein
                        Postfach bei Proton wird nicht angefasst.
                    </p>

                    {confirming === undefined ? (
                        <div className="row" style={{ gap: 8 }}>
                            <button
                                type="button"
                                className="button button-danger-quiet"
                                disabled={busy || !status.signedIn}
                                onClick={() => setConfirming('local')}
                            >
                                Verbindung trennen
                            </button>
                            <button
                                type="button"
                                className="button button-danger-quiet"
                                disabled={busy || !status.signedIn}
                                onClick={() => setConfirming('everywhere')}
                            >
                                Trennen und bei Proton abmelden
                            </button>
                        </div>
                    ) : (
                        <>
                            <p className="notice notice-danger">
                                <strong>Sicher?</strong>{' '}
                                {confirming === 'everywhere'
                                    ? 'Die Sitzung wird auch bei Proton beendet — danach ist das Token dort tot, und auch dein Browser-Profil kommt damit nicht mehr weiter.'
                                    : 'Die Sitzung wird nur hier vergessen. Bei Proton bleibt sie gültig, bis sie abläuft, und dein Browser-Profil bleibt angemeldet — die nächste Anmeldung geht dort vermutlich ohne Passwort durch.'}
                            </p>
                            <div className="row" style={{ gap: 8 }}>
                                <button
                                    type="button"
                                    className="button button-danger"
                                    disabled={busy}
                                    aria-busy={busy}
                                    onClick={() => disconnect(confirming === 'everywhere')}
                                >
                                    {busy && <span className="spinner" aria-hidden="true" />}
                                    {busy ? 'Wird getrennt …' : 'Ja, trennen'}
                                </button>
                                <button
                                    type="button"
                                    className="button button-quiet"
                                    disabled={busy}
                                    onClick={() => setConfirming(undefined)}
                                >
                                    Abbrechen
                                </button>
                            </div>
                        </>
                    )}

                    {refusal !== undefined && <p className="notice notice-warning">{refusal}</p>}
                </>
            )}
        </div>
    );
}
