import { useLogin } from '../login.js';

/**
 * The sign-in button, and everything it is honest about.
 *
 * Three sentences do most of the work here. That no password passes through this page — the window
 * that opens is Proton's own login form in a real browser profile, so a password manager's
 * extension fills it exactly as it would anywhere else. That the tool will not sign in when it does
 * not need to: a stored session is reused, and this button is for when there is none. And that a
 * refused attempt is refused for a reason, rather than being retried.
 *
 * That last one is not decoration. This account was locked out once by repeated attempts, and a
 * button in a web interface makes repeating easy. So a refusal from `LoginGuard` is shown as what
 * it is, with no button beside it to press again.
 */
export function LoginPanel(): React.JSX.Element | null {
    const { status, connected, start, refusal } = useLogin();

    if (!connected || !status.available) {
        return null;
    }

    const running = status.state === 'opening' || status.state === 'waiting';

    return (
        <div className="sync-panel">
            <div className="row">
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={running}
                    aria-busy={running}
                    onClick={start}
                >
                    {running && <span className="spinner" aria-hidden="true" />}
                    {running ? 'Fenster ist offen …' : 'Bei Proton anmelden'}
                </button>
            </div>

            {status.state === 'opening' && (
                <p className="faint">Der Browser startet. Das kann ein paar Sekunden dauern.</p>
            )}

            {status.state === 'waiting' && (
                <p className="notice notice-info">
                    <strong>Das Fenster wartet auf dich.</strong> Es zeigt Protons eigene
                    Anmeldeseite — dein Passwort-Manager füllt sie aus wie auf jeder anderen Seite,
                    und ein Passkey funktioniert, weil es ein echtes Profil ist. Hier läuft kein
                    Passwort durch.
                </p>
            )}

            {status.state === 'done' && (
                <p className="notice notice-info">
                    <strong>Angemeldet.</strong> Die Sitzung ist verschlüsselt gespeichert; der
                    nächste Start braucht keine Anmeldung.
                </p>
            )}

            {status.state === 'failed' && (
                <p className="notice notice-danger">
                    <strong>
                        Anmeldung fehlgeschlagen{status.code === undefined ? '' : ` (${status.code})`}.
                    </strong>{' '}
                    {status.error}
                    <br />
                    <br />
                    Es wird <strong>nicht</strong> automatisch erneut versucht. Dieses Konto war
                    einmal gesperrt, weil zu oft hintereinander angemeldet wurde — ein neuer Versuch
                    ist deshalb eine bewusste Handlung.
                </p>
            )}

            {refusal !== undefined && <p className="notice notice-warning">{refusal}</p>}
        </div>
    );
}
