import { useAccount } from '../account.js';
import { Hint } from './Hint.js';

/**
 * Locking the dashboard, from wherever you happen to be.
 *
 * In the sidebar rather than in the settings, because it is not a setting: it is the thing you do
 * when you stand up, and a control you need on the way out should not be three clicks away behind a
 * tab. The settings keep the fuller version — „sofort sperren", the grace period, the password.
 *
 * It says what it will do before it does it. „Abmelden" that silently held the key for half an hour
 * would be a lie about how locked „gesperrt" is; the grace period is a real convenience and it is
 * stated where it applies. But it is stated on the button itself, not next to it: an `i` mark here
 * meant a second thing to aim at in the corner of the navigation, for a sentence that belongs to the
 * button anyway.
 */
export function LockButton(): React.JSX.Element | null {
    const { status, served, perform } = useAccount();

    // Nothing to lock: no server, no account surface, or a session that is not open anyway.
    if (!served || !status.available || !status.registered || !status.unlocked) {
        return null;
    }

    return (
        <div className="sidebar-account">
            <span className="faint">{status.username ?? 'angemeldet'}</span>
            <Hint
                text={
                    status.graceMinutes > 0
                        ? `Der Schlüssel wird noch ${String(status.graceMinutes)} Minuten gehalten — so lange kommst du ohne Passwort zurück und die Verbindung zu Proton bleibt bestehen. Danach ist er weg und die lokale Kopie wird geschlossen. Die Dauer lässt sich in den Einstellungen ändern, bis hinunter auf 0.`
                        : 'Der Schlüssel wird sofort verworfen und die lokale Kopie geschlossen. Der nächste Zugang braucht wieder das Passwort.'
                }
            >
                <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                        void perform({ action: 'lock' });
                    }}
                >
                    Abmelden
                </button>
            </Hint>
        </div>
    );
}
