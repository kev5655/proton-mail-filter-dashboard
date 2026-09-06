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
    const { status, connected, start, refusal, blocked } = useLogin();

    if (!connected || !status.available) {
        return null;
    }

    const running = status.state === 'opening' || status.state === 'waiting';

    // Connected already: the sidebar has nothing to offer. Disconnecting lives in the settings,
    // where a decision that deletes the local copy belongs — not one click from every screen.
    if (status.signedIn && !running && status.state !== 'failed') {
        return null;
    }

    /*
     * The guard's verdict, before anything is offered.
     *
     * Two refusals that look alike and are not. A **cooldown** ends by itself, so the button stays
     * and says when — hiding it would leave somebody guessing whether the tool still works. A
     * **lock** does not end: no waiting clears it, only the owner signing in at mail.proton.me and
     * running `pnpm spike --lockout-cleared`. A button there would be a button that is refused every
     * single time, which is exactly what earned this account its lockout.
     */
    if (blocked?.lockedOut === true) {
        return (
            <div className="sync-panel">
                <p className="notice notice-danger">
                    <strong>Anmeldung gesperrt.</strong> {blocked.reason}
                    <br />
                    <br />
                    Kein Warten hebt das auf. Melde dich bei mail.proton.me an und sieh nach, dass
                    das Konto erreichbar ist — danach gibt <code>pnpm spike --lockout-cleared</code>{' '}
                    es wieder frei. Absichtlich kein Knopf hier: dieses Konto war schon einmal
                    gesperrt, weil ein Programm es weiter versucht hat.
                </p>
            </div>
        );
    }

    const waitingUntil = blocked?.retryAfter;
    const cooling = waitingUntil !== undefined && waitingUntil * 1000 > Date.now();

    return (
        <div className="sync-panel">
            <div className="row">
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={running || cooling}
                    aria-busy={running}
                    onClick={start}
                >
                    {running && <span className="spinner" aria-hidden="true" />}
                    {running ? 'Fenster ist offen …' : 'Bei Proton anmelden'}
                </button>
            </div>

            {cooling && (
                <p className="notice notice-warning">
                    <strong>Noch gesperrt.</strong> {blocked?.reason} Der Knopf wird von selbst
                    wieder aktiv — ein Versuch währenddessen würde ohnehin abgelehnt und die
                    Wartezeit verlängern.
                </p>
            )}

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
