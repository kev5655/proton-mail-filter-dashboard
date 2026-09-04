import { useSyncExternalStore, useState } from 'react';

import { buildIncidentReport, snapshot, subscribe } from '../log.js';
import { describeEvent } from '../log-text.js';

/**
 * What the tool did, in the order it did it.
 *
 * Here because this project is meant to be extended with an assistant, and the bottleneck there is
 * describing a fault rather than fixing one. The export produces text that can be pasted straight
 * into a conversation — error codes and counts, no subject lines, no addresses, no folder names. A
 * report that has to be redacted first does not get sent.
 *
 * A section of „Verlauf" rather than a screen of its own. It answers a different question from the
 * list above it — what this tab did, not what reached the account — and the two were being read as
 * one because they sat on separate tabs with nothing saying how they differed. It is also the only
 * trace that exists when an offer never arrived at the server at all.
 */
export function ActivityLog(): React.JSX.Element {
    const entries = useSyncExternalStore(subscribe, snapshot, snapshot);
    const [copied, setCopied] = useState(false);
    /**
     * The event keys, off by default.
     *
     * They are what a bug report needs and the wrong thing to read first: „apply.applied" and
     * „partial=false" answered a question nobody asked, while the one somebody did ask — was my
     * rule saved? — was not on the screen at all. The keys stay one click away, and the exported
     * report carries them whether this is on or not.
     */
    const [technical, setTechnical] = useState(false);

    async function copyReport(): Promise<void> {
        await navigator.clipboard.writeText(buildIncidentReport('0.1.0'));
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
    }

    return (
        <>
            <p className="faint">
                Was in diesem Tab passiert ist, in Sätzen. Der kopierte Bericht enthält dieselben
                Ereignisse als Fehlercodes und Zahlen — keine Mailinhalte, keine Adressen, keine
                Ordnernamen, damit er ohne Nachbearbeitung weitergegeben werden kann. Diese Liste
                lebt im Tab und ist beim Neuladen weg; was am Konto geändert wurde, steht oben und
                bleibt.
            </p>

            <div className="row" style={{ marginBottom: 12 }}>
                <button type="button" className="button" onClick={() => void copyReport()}>
                    {copied ? 'In die Zwischenablage kopiert' : 'Bericht kopieren'}
                </button>
                <button
                    type="button"
                    className="button button-quiet"
                    aria-pressed={technical}
                    onClick={() => {
                        setTechnical(!technical);
                    }}
                >
                    {technical ? 'Technische Details ausblenden' : 'Technische Details'}
                </button>
                <span className="faint">{entries.length} Einträge</span>
            </div>

            {entries.length === 0 && <p className="muted">Noch nichts passiert.</p>}

            {entries.length > 0 && (
                <div className="card">
                    <table className="diff-table">
                        <thead>
                            <tr>
                                <th>Zeit</th>
                                <th>Was passiert ist</th>
                                {technical && <th>Ereignis</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((entry) => (
                                <tr key={`${entry.at}-${entry.event}`}>
                                    <td className="faint">
                                        {new Date(entry.at).toLocaleTimeString('de-CH')}
                                    </td>
                                    <td>
                                        {entry.level !== 'info' && (
                                            <span
                                                className={
                                                    entry.level === 'error'
                                                        ? 'badge badge-danger'
                                                        : 'badge badge-warning'
                                                }
                                            >
                                                {entry.level === 'error' ? 'Fehler' : 'Achtung'}
                                            </span>
                                        )}{' '}
                                        {describeEvent(entry)}
                                    </td>
                                    {technical && (
                                        <td className="faint">
                                            <code>{entry.event}</code>{' '}
                                            {Object.entries(entry.context)
                                                .map(([key, value]) => `${key}=${String(value)}`)
                                                .join(' ')}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}
