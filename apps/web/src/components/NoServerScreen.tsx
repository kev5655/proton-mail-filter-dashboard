/**
 * What you see when nothing is serving this dashboard.
 *
 * This screen is the whole point of removing the demo mailbox. Before it, a silent server produced
 * a plausible dashboard full of invented folders and rules, and a locked one produced the same
 * thing — so the two states that most need saying out loud were the two the interface hid. Somebody
 * whose vault had simply locked was shown a working tool with somebody else's mail in it, and no
 * button anywhere that led back.
 *
 * It offers a retry rather than reloading on a timer. The server comes up when a person starts it,
 * and a screen that quietly re-checks in the background is one that changes under you.
 *
 * No wake button here, deliberately: that is `WakeScreen`, and it appears only when the starter on
 * the host has actually answered that the service is stopped. Offering to start a machine that has
 * never existed is worse than offering nothing.
 */
export function NoServerScreen({ retry }: { retry: () => void }): React.JSX.Element {
    return (
        <div className="lock-screen">
            <div className="lock-card">
                <div className="stack">
                    <h1>Kein Server erreichbar</h1>
                    <p className="faint">
                        Dieses Dashboard zeigt ausschliesslich dein echtes Postfach, und dafür muss
                        der lokale Server laufen — er hält den Schlüssel und die verschlüsselte
                        Kopie. Erreichbar ist gerade keiner.
                    </p>
                    <p className="faint">
                        Starte ihn mit <code>pnpm serve</code>, oder — wenn er im Container läuft —
                        mit <code>docker start pms</code>.
                    </p>
                    <button type="button" className="button" onClick={retry}>
                        Nochmal nachsehen
                    </button>
                </div>
            </div>
        </div>
    );
}
