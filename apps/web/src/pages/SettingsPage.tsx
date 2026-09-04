import { useState } from 'react';

import { AccountSettings } from '../components/AccountSettings.js';
import { ProtonConnection } from '../components/ProtonConnection.js';
import { CLOUD_PRESETS, presetById } from '@pms/llm';

import { useModel } from '../llm.js';
import { useMailboxStatus } from '../mailbox.js';
import { protonMailUrl } from '../proton-link.js';
import { useAppState } from '../state.js';
import type { LlmMode } from '../settings.js';

/**
 * The few things worth choosing, and what each of them costs.
 *
 * Explicit save, no auto-apply: changing a base URL character by character would fire a
 * reachability check per keystroke, and a setting that takes effect while it is being typed is one
 * that cannot be corrected before it does.
 */
export function SettingsPage(): React.JSX.Element {
    const { settings, update, state, checkedAt, recheck, provider } = useModel();
    const status = useMailboxStatus();
    const [form, setForm] = useState(settings);
    const [saved, setSaved] = useState(false);
    const { nav } = useAppState();
    /**
     * Which half of the page is showing. „Anwendung" first: it is what people come here for.
     *
     * Unless something sent them here to fix a connection, in which case landing on the other tab
     * and making them find it would be half an answer.
     */
    const [tab, setTab] = useState<'app' | 'account'>(nav.focusConnection === true ? 'account' : 'app');
    // The page-size field keeps its own text, so it can be empty mid-edit without the form having
    // to hold a number that is not one.
    const [pageSizeText, setPageSizeText] = useState(String(settings.display.pageSize));

    const parsedPageSize = Number(pageSizeText);
    const pageSizeUsable =
        pageSizeText !== '' && Number.isInteger(parsedPageSize) && parsedPageSize >= 5 && parsedPageSize <= 100;

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
                    {tab === 'app'
                        ? 'Bleiben in diesem Browser. Nichts davon ist ein Geheimnis und nichts davon stammt aus deinem Postfach — der Server ist bewusst nur lesend und kann keine Einstellungen aufbewahren.'
                        : 'Wer du bist und woran dieses Werkzeug hängt. Nichts davon liegt im Browser: das Passwort schützt die lokale Kopie, und die Verbindung gehört dem Prozess, der sie hält.'}
                </p>
            </header>

            {/*
             * Two groups, kept apart.
             *
             * They were one list, and mixing them was the complaint. „Wie viele Mails pro Seite"
             * and „ändere das Passwort, an dem der Schlüssel zu deinem Postfach hängt" are not the
             * same kind of decision, they are not saved the same way — the left side waits for a
             * „Speichern", the right side takes effect the moment it is answered — and one of them
             * is reached for far more often than the other.
             */}
            <div className="settings-tabs" role="tablist">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'app'}
                    className="settings-tab"
                    onClick={() => {
                        setTab('app');
                    }}
                >
                    Anwendung
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'account'}
                    className="settings-tab"
                    onClick={() => {
                        setTab('account');
                    }}
                >
                    Konto und Verbindung
                </button>
            </div>

            {tab === 'account' && (
                <>
                    <AccountSettings />
                    <ProtonConnection />
                </>
            )}

            {tab === 'app' && (
                <>
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
                            {/*
                             * Two ways to reach a machine that is not this one, and they fail
                             * differently — which is the only reason both are named. Ollama answers
                             * only origins it was told to allow, and a blocked request arrives in a
                             * browser as the same network error as a dead port.
                             */}
                            <span className="faint">
                                <code>/ollama</code> geht über diese Seite — ohne CORS-Frage. Für ein
                                Ollama auf einem <strong>anderen Rechner</strong> gibt es zwei Wege:
                                entweder <code>PMS_OLLAMA_URL=http://…:11434</code> setzen und{' '}
                                <code>pnpm dev</code> neu starten, dann bleibt es <code>/ollama</code>{' '}
                                und die Seite fragt weiter ihren eigenen Ursprung — oder die
                                vollständige Adresse hier eintragen, dann muss dort{' '}
                                <code>OLLAMA_ORIGINS</code> diese Seite erlauben.
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

                {/*
                 * A model somebody else runs, and the sentence that has to come before the key
                 * field rather than after it.
                 *
                 * Ollama answers on localhost and nothing leaves. A hosted model gets the subject
                 * lines and sender addresses of the mail a rule would catch — for a tool whose
                 * argument is that a Proton account exists to withhold exactly that, this is a real
                 * trade and belongs where the decision is made.
                 */}
                {form.llm.mode === 'cloud' && (
                    <>
                        <p className="notice notice-warning" style={{ marginTop: 12 }}>
                            <strong>Damit verlassen Daten diesen Rechner.</strong> Gesendet werden
                            Betreffzeilen und Absenderadressen der betroffenen Mails — keine
                            Mailinhalte, die gibt es hier ohnehin nicht. Wer das Modell betreibt,
                            sieht sie. Bei Ollama ist das nicht so.
                        </p>

                        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                            <label className="stack">
                                <span className="faint">Anbieter</span>
                                <select
                                    className="text-input"
                                    value={form.llm.cloud.provider}
                                    aria-label="Anbieter"
                                    onChange={(event) => {
                                        const next = presetById(event.target.value);
                                        setForm({
                                            ...form,
                                            llm: {
                                                ...form.llm,
                                                cloud: {
                                                    ...form.llm.cloud,
                                                    provider: event.target.value,
                                                    // Only when the field is still empty: overwriting
                                                    // a model somebody typed would be the tidier
                                                    // kind of rude.
                                                    model:
                                                        form.llm.cloud.model === ''
                                                            ? (next?.defaultModel ?? '')
                                                            : form.llm.cloud.model,
                                                },
                                            },
                                        });
                                    }}
                                >
                                    {CLOUD_PRESETS.map((preset) => (
                                        <option key={preset.id} value={preset.id}>
                                            {preset.label}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            <label className="stack">
                                <span className="faint">Modell</span>
                                <input
                                    type="text"
                                    className="text-input"
                                    value={form.llm.cloud.model}
                                    placeholder={presetById(form.llm.cloud.provider)?.defaultModel ?? ''}
                                    aria-label="Modellname beim Anbieter"
                                    onChange={(event) =>
                                        setForm({
                                            ...form,
                                            llm: {
                                                ...form.llm,
                                                cloud: { ...form.llm.cloud, model: event.target.value },
                                            },
                                        })
                                    }
                                />
                            </label>
                        </div>

                        {presetById(form.llm.cloud.provider)?.baseUrl === '' && (
                            <label className="stack" style={{ marginTop: 12 }}>
                                <span className="faint">Adresse (OpenAI-kompatibel)</span>
                                <input
                                    type="text"
                                    className="text-input"
                                    value={form.llm.cloud.baseUrl}
                                    placeholder="https://…/v1"
                                    aria-label="Adresse des Anbieters"
                                    onChange={(event) =>
                                        setForm({
                                            ...form,
                                            llm: {
                                                ...form.llm,
                                                cloud: { ...form.llm.cloud, baseUrl: event.target.value },
                                            },
                                        })
                                    }
                                />
                            </label>
                        )}

                        <label className="stack" style={{ marginTop: 12 }}>
                            <span className="faint">API-Schlüssel</span>
                            <input
                                type="password"
                                className="text-input"
                                value={form.llm.cloud.apiKey}
                                autoComplete="off"
                                aria-label="API-Schlüssel"
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        llm: {
                                            ...form.llm,
                                            cloud: { ...form.llm.cloud, apiKey: event.target.value },
                                        },
                                    })
                                }
                            />
                            <span className="faint">
                                Liegt im Speicher dieses Browsers, wie die übrigen Einstellungen —
                                nicht verschlüsselt. Wer an diesen Rechner kommt, kommt an den
                                Schlüssel.
                                {presetById(form.llm.cloud.provider)?.keysUrl !== undefined &&
                                    presetById(form.llm.cloud.provider)?.keysUrl !== '' && (
                                        <>
                                            {' '}
                                            <a
                                                href={presetById(form.llm.cloud.provider)?.keysUrl}
                                                target="_blank"
                                                rel="noreferrer noopener"
                                            >
                                                Schlüssel holen
                                            </a>
                                        </>
                                    )}
                            </span>
                        </label>
                    </>
                )}

                {/*
                 * Nothing to check when there is nothing configured. „Verbindung prüfen" next to
                 * „Aus" offers to test the absence of a thing, which is the sort of button that
                 * makes an interface feel automatic rather than thought about.
                 */}
                <div className="row" style={{ marginTop: 12 }}>
                    {form.llm.mode !== 'off' && (
                        <button
                            type="button"
                            className="button button-quiet"
                            disabled={state === 'checking' || dirty}
                            aria-busy={state === 'checking'}
                            onClick={recheck}
                        >
                            {state === 'checking' && <span className="spinner" aria-hidden="true" />}
                            {state === 'checking' ? 'Wird geprüft …' : 'Verbindung prüfen'}
                        </button>
                    )}
                    <span className="faint">
                        {/*
                         * „Eingerichtet", not „erreichbar", for a hosted model. Probing one costs a
                         * request and money, so what was actually checked is that a key, a model and
                         * an address are present — and the word has to say that rather than imply a
                         * round trip nobody made.
                         */}
                        {state === 'available' &&
                            (form.llm.mode === 'cloud'
                                ? `Eingerichtet — ${provider.name}. Ob der Schlüssel stimmt, zeigt erst die erste Anfrage.`
                                : `Erreichbar — ${provider.name}.`)}
                        {state === 'checking' && 'Wird geprüft …'}
                        {state === 'disabled' && 'Kein Modell eingerichtet.'}
                        {state === 'unavailable' && 'Nicht erreichbar.'}
                        {/*
                         * The time the answer is from.
                         *
                         * Without it a second press looks like a button that does nothing: the
                         * check lands on the same answer, so neither the state nor the sentence
                         * changes. A clock that moves says „it ran, and the answer is the same".
                         */}
                        {checkedAt !== undefined && state !== 'checking' && state !== 'disabled' && (
                            <> Zuletzt geprüft: {new Date(checkedAt).toLocaleTimeString('de-CH')}.</>
                        )}
                    </span>
                </div>

                {/*
                 * What is checked is what is saved.
                 *
                 * The provider is built from the stored settings, so a check while the form is
                 * dirty would test the previous address and report on it confidently. Saying so is
                 * better than either silently testing the wrong thing or saving on somebody's
                 * behalf because they pressed a button labelled „prüfen".
                 */}
                {dirty && form.llm.mode !== 'off' && (
                    <p className="faint">
                        Geprüft wird, was gespeichert ist — erst <em>Speichern</em>, dann prüfen.
                    </p>
                )}

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
                {/* Capped like every other short answer: a card is wider than a two-digit number. */}
                <label className="stack" style={{ maxWidth: 220 }}>
                    <span className="faint">Mails pro Seite</span>
                    {/*
                     * Held as text while it is being edited.
                     *
                     * As a number it could not be emptied: clearing the field to type something
                     * longer produced `Number('') || 10`, which put the 10 straight back and made
                     * „30" impossible to type without selecting the old value first. An empty field
                     * is a legitimate state *while typing* and an illegitimate one to save, which is
                     * two different rules — so the field allows it and the save button does not.
                     */}
                    <input
                        type="number"
                        min={5}
                        max={100}
                        className="text-input"
                        value={pageSizeText}
                        onChange={(event) => {
                            const next = event.target.value;
                            setPageSizeText(next);
                            const parsed = Number(next);
                            if (next !== '' && Number.isFinite(parsed)) {
                                setForm({ ...form, display: { pageSize: parsed } });
                            }
                        }}
                        aria-label="Mails pro Seite"
                    />
                    {!pageSizeUsable && (
                        <span className="faint">
                            Zwischen 5 und 100. Solange hier nichts Gültiges steht, lässt sich nicht
                            speichern.
                        </span>
                    )}
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
                <button
                    type="button"
                    className="button"
                    disabled={!dirty || !pageSizeUsable}
                    onClick={save}
                >
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
            )}
        </>
    );
}

/**
 * The three answers, and the one that used to be four.
 *
 * „Platzhalter" is gone: a stand-in answering from a lookup table is the wrong thing to offer next
 * to a real mailbox, because it puts generated-looking text exactly where a judgement would go.
 * Somebody looking at their own mail wants a model or no model, not a rehearsal of one.
 */
const MODES: Array<{ value: LlmMode; label: string; hint: string }> = [
    { value: 'off', label: 'Aus', hint: 'Kein Modell. Alles Abgeleitete funktioniert weiterhin.' },
    {
        value: 'ollama',
        label: 'Ollama',
        hint: 'Auf diesem Rechner oder auf einem anderen im Netz. Nichts verlässt dein Netz.',
    },
    {
        value: 'cloud',
        label: 'Anbieter mit API-Schlüssel',
        hint: 'OpenAI, Anthropic und andere. Betreffzeilen und Absender verlassen dabei diesen Rechner.',
    },
];
