import { Info } from './Info.js';
import { useLogin } from '../login.js';
import { useMailboxStatus } from '../mailbox.js';
import { useSync } from '../sync.js';

/**
 * The four things worth knowing at a glance, in the corner, without a sentence.
 *
 * Everything on this strip is a *state*, not an explanation: connected or not, how old the copy is,
 * when it refreshes next. Those get read dozens of times a day and never need a paragraph — so they
 * are a dot and a number, and the paragraph is behind the mark next to them.
 *
 * The one thing that is *not* here is which mailbox this is. That stays where it is, in full, on
 * every screen: somebody looking at a plausible list of their own folder names must never have to
 * hover something to find out whether it is theirs.
 */
export function StatusStrip(): React.JSX.Element | null {
    const status = useMailboxStatus();
    const login = useLogin();
    const sync = useSync();

    // Nothing to report about a demo: there is no connection, no copy and no timer.
    if (status.source === 'demo') {
        return null;
    }

    const connected = login.status.signedIn;
    const running = sync.status.state === 'running';

    return (
        <div className="status-strip">
            <span className={connected ? 'status-pill is-good' : 'status-pill is-bad'}>
                <span className="status-dot" aria-hidden="true" />
                {connected ? 'Verbunden' : 'Getrennt'}
                <Info label="Was der Verbindungsstatus bedeutet">
                    {connected
                        ? 'Dieser Server hält eine gültige Proton-Sitzung. Gelesen wird trotzdem nur beim Synchronisieren; das Dashboard zeigt immer die lokale Kopie.'
                        : 'Es liegt keine gültige Proton-Sitzung vor. Die lokale Kopie lässt sich weiter ansehen, aber nichts wird geholt und nichts geschrieben. Neu verbinden unter Einstellungen → Konto und Verbindung.'}
                </Info>
            </span>

            <span className="status-pill">
                {running ? 'Sync läuft' : ago(status.syncedAt)}
                <Info label="Stand der lokalen Kopie">
                    {status.syncedAt === undefined
                        ? 'Es ist noch keine Synchronisation fertig geworden.'
                        : `Letzte Synchronisation: ${new Date(status.syncedAt * 1000).toLocaleString('de-CH')}.`}{' '}
                    Das Dashboard rechnet immer mit dieser Kopie, nie mit dem Konto — was seither bei
                    Proton passiert ist, steht hier noch nicht drin.
                    {status.truncated &&
                        ' Der letzte Sync hat seine Obergrenze erreicht, die Kopie ist unvollständig.'}
                </Info>
            </span>

            {sync.status.available && (
                <span className="status-pill">
                    {nextSync(sync.status.nextRunAt, running)}
                    <Info label="Automatische Synchronisation">
                        {sync.status.nextRunAt === undefined
                            ? 'Es ist keine automatische Synchronisation eingeplant — `pnpm serve --auto-sync 0` oder ein Server ohne Timer.'
                            : `Die nächste läuft um ${new Date(sync.status.nextRunAt * 1000).toLocaleTimeString('de-CH')}. Die Uhr stellt sich bei jedem Sync neu, also gilt der Abstand ab dem letzten Lauf.`}
                    </Info>
                </span>
            )}
        </div>
    );
}

/** How old the copy is, in the roughest unit that is still true. */
function ago(syncedAt: number | undefined): string {
    if (syncedAt === undefined) {
        return 'kein Stand';
    }
    const minutes = Math.max(0, Math.round(Date.now() / 60_000 - syncedAt / 60));
    if (minutes < 1) {
        return 'gerade eben';
    }
    if (minutes < 60) {
        return `vor ${String(minutes)} min`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `vor ${String(hours)} h` : `vor ${String(Math.round(hours / 24))} d`;
}

function nextSync(nextRunAt: number | undefined, running: boolean): string {
    if (running) {
        return 'jetzt';
    }
    if (nextRunAt === undefined) {
        return 'kein Timer';
    }
    const minutes = Math.round(nextRunAt - Date.now() / 1000) / 60;
    // Rounded up, and never below one: „in 0 min" reads as „now" for something that has not
    // started, which is the one thing this label must not say.
    return minutes <= 1 ? 'in <1 min' : `in ${String(Math.ceil(minutes))} min`;
}
