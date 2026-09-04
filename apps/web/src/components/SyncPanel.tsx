import { useMailboxStatus } from '../mailbox.js';
import { STAGE_NAMES, useSync } from '../sync.js';

/**
 * When the copy was last refreshed, and a way to refresh it.
 *
 * The progress bar has a genuinely indeterminate state, and that is the point of writing one rather
 * than using a percentage. Proton does not report how many messages there are until the first page
 * comes back, so for the first second there is no total — and inventing a number to fill the bar
 * would be a small lie in a tool whose whole argument is that it does not tell them.
 */
export function SyncPanel(): React.JSX.Element | null {
    const mailbox = useMailboxStatus();
    const { status, connected, start, refusal } = useSync();

    if (mailbox.source === 'demo') {
        return null;
    }

    const running = status.state === 'running';
    const progress = running ? status.progress : undefined;
    const share =
        progress?.total !== undefined && progress.total > 0
            ? Math.min(1, progress.done / progress.total)
            : undefined;

    return (
        <div className="sync-panel">
            <div className="row">
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={running || !connected || !status.available}
                    onClick={start}
                >
                    {running ? 'Synchronisiert …' : 'Jetzt synchronisieren'}
                </button>
            </div>

            {!connected && (
                <p className="faint">
                    Kein Server erreichbar. Mit <code>pnpm serve</code> starten.
                </p>
            )}

            {connected && !status.available && (
                <p className="faint">
                    Dieser Server kann nicht synchronisieren — er hat keine Verbindung zu Proton.
                </p>
            )}

            {running && (
                <div className="progress-block">
                    <div
                        className="progress"
                        role="progressbar"
                        aria-label="Fortschritt der Synchronisation"
                        {...(share === undefined
                            ? {}
                            : {
                                  'aria-valuenow': Math.round(share * 100),
                                  'aria-valuemin': 0,
                                  'aria-valuemax': 100,
                              })}
                    >
                        <div
                            className={share === undefined ? 'progress-fill progress-unknown' : 'progress-fill'}
                            style={share === undefined ? undefined : { width: `${String(share * 100)}%` }}
                        />
                    </div>
                    <p className="faint">
                        {progress === undefined
                            ? 'Verbindung wird aufgebaut …'
                            : `${STAGE_NAMES[progress.stage]}: ${progress.done}${
                                  progress.total === undefined ? '' : ` von ${progress.total}`
                              }`}
                        {progress?.total === undefined && progress !== undefined && ' — Gesamtzahl noch unbekannt'}
                    </p>
                    <p className="faint">
                        Rund eine Sekunde pro hundert Mails. Das ist die Drosselung und kein Hänger.
                    </p>
                </div>
            )}

            {status.state === 'done' && (
                <p className="faint">
                    ✓ {status.summary.messages} Mails, {status.summary.filters} Filter,{' '}
                    {status.summary.labels} Ordner und Labels geholt.
                    {status.summary.truncated && ' Bei der Obergrenze abgebrochen — die Kopie ist unvollständig.'}
                </p>
            )}

            {status.state === 'failed' && (
                <p className="notice notice-danger">
                    Synchronisation fehlgeschlagen{status.code === undefined ? '' : ` (${status.code})`}:{' '}
                    {status.error}. Am Konto hat sich dadurch nichts geändert — ein Sync liest nur.
                </p>
            )}

            {refusal !== undefined && <p className="notice notice-warning">{refusal}</p>}
        </div>
    );
}
