import { useState } from 'react';

import { useModel } from '../llm.js';
import { useMailboxStatus } from '../mailbox.js';
import { protonMailUrl } from '../proton-link.js';
import type { LlmMode } from '../settings.js';

/**
 * The few things worth choosing, and what each of them costs.
 *
 * Explicit save, no auto-apply: changing a base URL character by character would fire a
 * reachability check per keystroke, and a setting that takes effect while it is being typed is one
 * that cannot be corrected before it does.
 */
export function SettingsPage(): React.JSX.Element {
    const { settings, update, state, recheck, provider } = useModel();
    const status = useMailboxStatus();
    const [form, setForm] = useState(settings);
    const [saved, setSaved] = useState(false);

    const dirty = JSON.stringify(form) !== JSON.stringify(settings);

    const save = (): void => {
        update(form);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2500);
    };

    return (
        <>
            <header className="page-head">
                <h1>Einstellungen</h1>
                <p>
                    Bleiben in diesem Browser. Nichts davon ist ein Geheimnis und nichts davon stammt
                    aus deinem Postfach — der Server ist bewusst nur lesend und kann keine
                    Einstellungen aufbewahren.
                </p>
            </header>

            <div className="card">
                <h2>Sprachmodell</h2>
                <p className="faint">
                    Optional. Ein Modell benennt und erklärt — es entscheidet nie, was eine Regel
                    trifft. Das kommt aus dem Compiler und dem Matcher und ist überprüfbar.
                </p>

                <div className="statement-choice" style={{ marginTop: 12 }}>
                    {MODES.map((mode) => (
                        <label key={mode.value} className="radio-row">
                            <input
                                type="radio"
                                name="llm-mode"
                                checked={form.llm.mode === mode.value}
                                onChange={() => setForm({ ...form, llm: { ...form.llm, mode: mode.value } })}
                            />
                            <strong>{mode.label}</strong>
                            <span className="faint">{mode.hint}</span>
                        </label>
                    ))}
                </div>

                {form.llm.mode === 'ollama' && (
                    <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                        <label className="stack">
                            <span className="faint">Adresse</span>
                            <input
                                type="text"
                                className="text-input"
                                value={form.llm.baseUrl}
                                onChange={(event) =>
                                    setForm({ ...form, llm: { ...form.llm, baseUrl: event.target.value } })
                                }
                                aria-label="Ollama-Adresse"
                            />
                        </label>
                        <label className="stack">
                            <span className="faint">Modell</span>
                            <input
                                type="text"
                                className="text-input"
                                value={form.llm.model}
                                onChange={(event) =>
                                    setForm({ ...form, llm: { ...form.llm, model: event.target.value } })
                                }
                                aria-label="Modellname"
                            />
                        </label>
                    </div>
                )}

                <div className="row" style={{ marginTop: 12 }}>
                    <button type="button" className="button button-quiet" onClick={recheck}>
                        Verbindung prüfen
                    </button>
                    <span className="faint">
                        {state === 'available' && `Erreichbar — ${provider.name}.`}
                        {state === 'checking' && 'Wird geprüft …'}
                        {state === 'disabled' && 'Ausgeschaltet.'}
                        {state === 'unavailable' && 'Nicht erreichbar.'}
                    </span>
                </div>

                {state === 'unavailable' && form.llm.mode === 'ollama' && (
                    <p className="notice notice-warning">
                        Unter {form.llm.baseUrl} antwortet nichts. Läuft <code>ollama serve</code>, und
                        ist das Modell geladen? Ein Modell holen:{' '}
                        <code>ollama pull {form.llm.model}</code>. Ohne Modell funktioniert alles
                        andere weiter.
                    </p>
                )}
            </div>

            <div className="card">
                <h2>Links zu Proton</h2>
                <p className="faint">
                    Mails im Dashboard verlinken auf Protons Weboberfläche, weil der Inhalt hier nicht
                    angezeigt werden kann. <strong>Die Adressform ist geraten</strong> — sie steht
                    nirgends dokumentiert und wurde aus der Adresszeile abgelesen. Falls ein Link
                    danebengeht, lässt er sich hier korrigieren.
                </p>

                <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                    <label className="stack">
                        <span className="faint">Host</span>
                        <input
                            type="text"
                            className="text-input"
                            value={form.proton.host}
                            onChange={(event) =>
                                setForm({ ...form, proton: { ...form.proton, host: event.target.value } })
                            }
                            aria-label="Proton-Host"
                        />
                    </label>
                    <label className="stack">
                        <span className="faint">Konto-Index (das u/&lt;n&gt; im Pfad)</span>
                        <input
                            type="number"
                            min={0}
                            className="text-input"
                            value={form.proton.account}
                            onChange={(event) =>
                                setForm({
                                    ...form,
                                    proton: { ...form.proton, account: Number(event.target.value) || 0 },
                                })
                            }
                            aria-label="Konto-Index"
                        />
                    </label>
                </div>

                <p className="faint" style={{ marginTop: 10 }}>
                    Beispiel:{' '}
                    <code>
                        {protonMailUrl({ ID: 'abc123', Subject: 'Beispiel' }, form.proton)}
                    </code>
                </p>
            </div>

            <div className="card">
                <h2>Anzeige</h2>
                <label className="stack">
                    <span className="faint">Mails pro Seite</span>
                    <input
                        type="number"
                        min={5}
                        max={100}
                        className="text-input"
                        value={form.display.pageSize}
                        onChange={(event) =>
                            setForm({
                                ...form,
                                display: { pageSize: Number(event.target.value) || 10 },
                            })
                        }
                        aria-label="Mails pro Seite"
                    />
                </label>
            </div>

            <div className="card">
                <h2>Postfach</h2>
                <p className="faint">
                    {status.source === 'demo'
                        ? 'Demo-Daten. Für das echte Postfach: pnpm sync, dann pnpm serve.'
                        : `Echtes Postfach, gelesen aus der lokalen Kopie. Stand: ${
                              status.syncedAt === undefined
                                  ? 'unbekannt'
                                  : new Date(status.syncedAt * 1000).toLocaleString('de-CH')
                          }.`}
                </p>
                {status.truncated && (
                    <p className="notice notice-warning">
                        Die Kopie ist unvollständig — der letzte Sync hat seine Obergrenze erreicht.
                    </p>
                )}
            </div>

            <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="button" disabled={!dirty} onClick={save}>
                    Speichern
                </button>
                {dirty && (
                    <button type="button" className="button button-quiet" onClick={() => setForm(settings)}>
                        Verwerfen
                    </button>
                )}
                {saved && <span className="faint">Gespeichert.</span>}
            </div>
        </>
    );
}

const MODES: Array<{ value: LlmMode; label: string; hint: string }> = [
    { value: 'off', label: 'Aus', hint: 'Kein Modell. Alles Abgeleitete funktioniert weiterhin.' },
    {
        value: 'ollama',
        label: 'Ollama',
        hint: 'Ein Modell auf diesem Rechner oder im Netz.',
    },
    {
        value: 'demo',
        label: 'Platzhalter',
        hint: 'Fest verdrahtete Antworten zum Ausprobieren der Oberfläche — kein Modell.',
    },
];
