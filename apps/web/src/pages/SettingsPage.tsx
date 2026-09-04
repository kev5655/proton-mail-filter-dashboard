import { useState } from 'react';

import { ProtonConnection } from '../components/ProtonConnection.js';
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
                            <span className="faint">
                                <code>/ollama</code> geht über diese Seite an dein lokales Ollama.
                                Eine vollständige Adresse ist für ein Ollama auf einem anderen
                                Rechner — dort muss dann <code>OLLAMA_ORIGINS</code> diese Seite
                                erlauben.
                            </span>
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

                {/*
                 * Two different failures behind one word.
                 *
                 * „Nicht erreichbar." covered both "nothing is listening" and "Ollama is running
                 * and refused to talk to this page", and the second one is invisible from here: a
                 * blocked cross-origin request arrives as the same network error as a dead port.
                 * Somebody whose model was running perfectly was told it was unreachable, with a
                 * hint telling them to start it.
                 */}
                {state === 'unavailable' && form.llm.mode === 'ollama' && (
                    <p className="notice notice-warning">
                        Unter <code>{form.llm.baseUrl}</code> antwortet nichts.
                        {form.llm.baseUrl.startsWith('/') ? (
                            <>
                                {' '}
                                Läuft <code>ollama serve</code>? Ein Modell holen:{' '}
                                <code>ollama pull {form.llm.model}</code>. Läuft Ollama auf einem
                                anderen Port, gehört er in <code>PMS_OLLAMA_URL</code>, bevor{' '}
                                <code>pnpm dev</code> startet.
                            </>
                        ) : (
                            <>
                                {' '}
                                Zwei mögliche Gründe, und von hier aus sehen sie gleich aus: dort
                                läuft nichts — oder Ollama läuft und lehnt diese Seite ab, weil ihre
                                Adresse nicht in <code>OLLAMA_ORIGINS</code> steht. Am einfachsten{' '}
                                <code>/ollama</code> eintragen, dann fragt die Seite ihren eigenen
                                Ursprung und die Frage stellt sich nicht.
                            </>
                        )}{' '}
                        Ohne Modell funktioniert alles andere weiter.
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
                <h2>Automatisch synchronisieren</h2>
                <p className="faint">
                    Wie oft <code>pnpm serve</code> nachholt, was seit dem letzten Mal dazugekommen
                    ist. Ein Sync von Hand stellt die Uhr ebenfalls neu — der Abstand gilt also ab
                    der letzten Synchronisation, nicht ab dem Start.
                </p>

                <label className="stack" style={{ maxWidth: 220 }}>
                    <span className="faint">Minuten (0 schaltet ab)</span>
                    <input
                        type="number"
                        min={0}
                        max={1440}
                        className="text-input"
                        value={form.sync.autoSyncMinutes}
                        onChange={(event) =>
                            setForm({
                                ...form,
                                sync: { autoSyncMinutes: Math.max(0, Number(event.target.value) || 0) },
                            })
                        }
                        aria-label="Minuten zwischen automatischen Synchronisationen"
                    />
                </label>

                {/*
                 * Two limits, both of them the truth rather than a caveat.
                 *
                 * The value travels to the server on the next manual sync, because the server has
                 * no writable configuration and is not getting one for a timer — and it lives in
                 * that `pnpm serve` process, so Ctrl+C ends it. A number that looks permanent and
                 * quietly is not would be the more comfortable lie and the worse one.
                 */}
                <p className="notice notice-info">
                    Gilt <strong>ab dem nächsten Sync von Hand</strong> und nur, solange dieses{' '}
                    <code>pnpm serve</code> läuft. Dauerhaft:{' '}
                    <code>pnpm serve --auto-sync {form.sync.autoSyncMinutes}</code>.
                </p>
            </div>

            <ProtonConnection />

            <div className="card">
                <h2>Anmelden</h2>
                <p className="faint">
                    Die Anmeldung läuft in einem echten Browser-Fenster, und das ist kein Umweg: Proton
                    schickt bei jeder Anmeldung eine Anti-Missbrauchs-Prüfung mit, die ihr eigenes
                    Skript in der Seite erzeugt. Ohne sie lehnt Proton ab, egal ob die Zugangsdaten
                    stimmen. Ein Passkey braucht ohnehin einen echten Browser.
                </p>

                {/*
                 * Three modes, and only one of them can have a password manager in it. Said here
                 * rather than discovered: somebody who picks „Playwright-Chromium" and then wonders
                 * where their 1Password extension went has been misled by an interface that offered
                 * a choice without its consequence.
                 */}
                <ul className="plain-list">
                    <li>
                        <strong>Chrome mit deinem Profil</strong> — der einzige Modus, in dem deine
                        1Password-Erweiterung überhaupt existiert, weil sie in diesem Profil steckt
                        und nicht in einem frisch angelegten. Auch der einzige, in dem ein Passkey
                        funktioniert. <code>PMS_BROWSER_CHANNEL=chrome</code> und{' '}
                        <code>PMS_BROWSER_PROFILE=…</code>
                    </li>
                    <li>
                        <strong>Playwright-Chromium, sichtbar</strong> — sauber getrennt vom
                        Alltagsbrowser, ohne Erweiterungen. Passwort von Hand.
                    </li>
                    <li>
                        <strong>Unsichtbar</strong> — für die erste Anmeldung nicht brauchbar: es gibt
                        niemanden, der tippt, und ein Passkey hat nichts zum Bestätigen. Das
                        Auffrischen einer bestehenden Sitzung braucht ohnehin keinen Browser.
                    </li>
                </ul>

                <p className="notice notice-warning">
                    <strong>Der Preis des Profil-Modus:</strong> die Proton-Cookies liegen danach in
                    Chromes eigenem Speicher, nicht nur in unserer verschlüsselten Datei. Das war
                    schon immer so und steht bisher nur in <code>.env.example</code> — es gehört
                    hierher.
                </p>

                <p className="faint">
                    Diese drei Werte liest der Server beim Start, bevor es diese Seite gibt. Sie
                    gehören deshalb in <code>.env</code> und nicht hierher — ein Feld, das nichts
                    bewirkt, wäre schlimmer als keines.
                </p>
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

            {/*
             * Say that something is waiting to be saved.
             *
             * Nothing here takes effect on change — a reachability probe per keystroke would hammer
             * a service while somebody is halfway through typing a port. But the only sign of that
             * was a greyed-out button going live, which is easy to miss and reads as a setting that
             * simply does not work: „ich habe Ollama eingeschaltet und es ist trotzdem aus".
             */}
            {dirty && (
                <p className="notice notice-warning" style={{ marginTop: 16 }}>
                    <strong>Noch nicht gespeichert.</strong> Änderungen an dieser Seite gelten erst
                    nach <em>Speichern</em> — bis dahin arbeitet das Dashboard mit den vorherigen
                    Werten weiter.
                </p>
            )}

            <div className="row" style={{ marginTop: 16 }}>
                <button type="button" className="button" disabled={!dirty} onClick={save}>
                    {dirty ? 'Speichern' : 'Gespeichert'}
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
