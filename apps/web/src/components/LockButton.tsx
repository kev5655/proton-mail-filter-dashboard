import { useAccount } from '../account.js';
import { Hint } from './Hint.js';

/**
 * Logging out, from wherever you happen to be.
 *
 * In the sidebar rather than in the settings, because it is not a setting: it is the thing you do
 * when you stand up, and a control you need on the way out should not be three clicks away behind a
 * tab.
 *
 * **It discards the key immediately, and that is a change.** It used to take the grace period — so
 * „Abmelden" held the key for half an hour, kept the database open and kept the Proton session
 * live. That put the weakening on the button people press most and the strong version behind a
 * settings tab, which is the wrong way round: the word means „I am done here", and a control whose
 * name promises more than it does is the kind nobody checks twice.
 *
 * The grace period still exists and is still worth having — it is what makes closing a tab cheap
 * rather than a reconnection to Proton a minute later. It is reachable as „Sperren" in the
 * settings, next to „Sofort sperren", where the two intentions are named side by side and the
 * difference between them is the point of the screen.
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
                    'Der Schlüssel wird sofort verworfen, die lokale Kopie geschlossen und die Proton-Sitzung in diesem Prozess beendet. Der nächste Zugang braucht wieder das Passwort. ' +
                    'Wenn du gleich zurückkommen willst, nimm „Sperren“ in den Einstellungen — das hält den Schlüssel für die Nachfrist.'
                }
            >
                <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                        void perform({ action: 'lock', immediate: true });
                    }}
                >
                    Abmelden
                </button>
            </Hint>
        </div>
    );
}
