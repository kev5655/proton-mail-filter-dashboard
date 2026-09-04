import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

import { useAccount } from '../account.js';

/**
 * Changing what guards the local data, from inside the thing it guards.
 *
 * Everything here needs the key, which means everything here is only reachable while unlocked —
 * that is not a UI convention, it is `Vault` refusing. Two of these deliberately ask for the
 * password again even so: switching a second factor off, and changing the password itself. An
 * unattended unlocked screen is exactly the situation those two protect against, and „you are
 * already logged in" is not an answer to it.
 *
 * The password change never re-encrypts anything. The master key stays as it is and only its
 * wrapping is redone, so there is no half-rewritten mailbox to be interrupted in the middle of.
 */
export function AccountSettings(): React.JSX.Element | null {
    const { status, served } = useAccount();

    // A server without an account surface guards nothing, and a settings page that offered to
    // change a password that does not exist would be inventing a feature.
    if (!served || !status.available || !status.registered) {
        return null;
    }

    return (
        <div className="card">
            <h2>Anmeldung an diesem Werkzeug</h2>
            <p className="faint">
                Angemeldet als <strong>{status.username ?? 'unbekannt'}</strong>. Dieses Passwort
                ist der Schlüssel für die lokale Kopie und die gespeicherte Proton-Sitzung — es
                schützt nicht nur diesen Bildschirm, es macht die Daten überhaupt erst lesbar.
            </p>

            <ChangePassword />
            <Totp />
            <Passkeys />
            <Grace />
            <Lock />
        </div>
    );
}

/** Shared shape: a small form that reports either the server's refusal or a short confirmation. */
function useAction(): {
    busy: boolean;
    error: string | undefined;
    done: string | undefined;
    run: (work: () => Promise<unknown>, success: string) => void;
    clear: () => void;
} {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [done, setDone] = useState<string | undefined>();

    return {
        busy,
        error,
        done,
        clear: () => {
            setError(undefined);
            setDone(undefined);
        },
        run: (work, success) => {
            setError(undefined);
            setDone(undefined);
            setBusy(true);
            void work()
                .then(() => {
                    setDone(success);
                })
                .catch((cause: Error) => {
                    setError(cause.message);
                })
                .finally(() => {
                    setBusy(false);
                });
        },
    };
}

function Result({ error, done }: { error?: string | undefined; done?: string | undefined }): React.JSX.Element | null {
    if (error !== undefined) {
        return <p className="notice notice-danger">{error}</p>;
    }
    if (done !== undefined) {
        return <p className="notice notice-info">{done}</p>;
    }
    return null;
}

function ChangePassword(): React.JSX.Element {
    const { perform } = useAccount();
    const { busy, error, done, run } = useAction();
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [repeat, setRepeat] = useState('');

    const mismatch = repeat !== '' && repeat !== next;
    const usable = current !== '' && next.length >= 8 && !mismatch && repeat !== '';

    return (
        <section className="settings-block form-stack">
            <h3>Passwort ändern</h3>
            <p className="faint">
                Der Schlüssel bleibt derselbe, nur seine Verpackung wird erneuert. Nichts wird neu
                verschlüsselt — es gibt also keinen halb umgeschriebenen Zustand, in dem eine
                Unterbrechung etwas kaputt machen könnte.
            </p>

            <label className="field">
                <span>Aktuelles Passwort</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="current-password"
                    value={current}
                    onChange={(event) => {
                        setCurrent(event.target.value);
                    }}
                />
            </label>
            <label className="field">
                <span>Neues Passwort</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="new-password"
                    value={next}
                    onChange={(event) => {
                        setNext(event.target.value);
                    }}
                />
            </label>
            <label className="field">
                <span>Neues Passwort wiederholen</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="new-password"
                    value={repeat}
                    onChange={(event) => {
                        setRepeat(event.target.value);
                    }}
                />
                {mismatch && <span className="field-error">Die beiden stimmen nicht überein.</span>}
            </label>

            <Result error={error} done={done} />

            <button
                type="button"
                className="button button-secondary"
                disabled={!usable || busy}
                onClick={() => {
                    run(async () => {
                        await perform({ action: 'change-password', current, next });
                        setCurrent('');
                        setNext('');
                        setRepeat('');
                    }, 'Das Passwort ist geändert. Ab dem nächsten Aufschliessen gilt das neue.');
                }}
            >
                {busy ? 'Wird geändert …' : 'Passwort ändern'}
            </button>
        </section>
    );
}

function Totp(): React.JSX.Element {
    const { status, perform } = useAccount();
    const { busy, error, done, run, clear } = useAction();
    const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | undefined>();
    const [code, setCode] = useState('');
    const [password, setPassword] = useState('');

    if (status.requiresTotp) {
        return (
            <section className="settings-block form-stack">
                <h3>Zwei-Faktor</h3>
                <p className="faint">
                    Eingeschaltet. Der Code wird bei jedem Aufschliessen verlangt — und er ist mit
                    dem Hauptschlüssel verschlüsselt gespeichert, damit jemand mit der Kontodatei
                    keine gültigen Codes erzeugen kann.
                </p>
                <label className="field">
                    <span>Passwort, um ihn abzuschalten</span>
                    <input
                        type="password"
                        className="text-input"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => {
                            setPassword(event.target.value);
                        }}
                    />
                    <span className="faint">
                        Wird noch einmal verlangt, weil ein unbeaufsichtigter offener Bildschirm
                        genau die Lage ist, gegen die ein zweiter Faktor hilft.
                    </span>
                </label>
                <Result error={error} done={done} />
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={password === '' || busy}
                    onClick={() => {
                        run(async () => {
                            await perform({ action: 'totp-disable', password });
                            setPassword('');
                        }, 'Zwei-Faktor ist abgeschaltet.');
                    }}
                >
                    Zwei-Faktor abschalten
                </button>
            </section>
        );
    }

    return (
        <section className="settings-block form-stack">
            <h3>Zwei-Faktor einschalten</h3>
            <p className="faint">
                Ein Code aus einer Authenticator-App, zusätzlich zum Passwort. Er wird erst
                gespeichert, wenn ein Code beweist, dass er in der App angekommen ist — sonst wäre
                ein Tippfehler beim Abtippen eine Aussperrung ohne Weg zurück.
            </p>

            {enrolment === undefined ? (
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                        run(async () => {
                            setEnrolment((await perform({ action: 'totp-begin' })) as {
                                secret: string;
                                uri: string;
                            });
                        }, '');
                    }}
                >
                    {busy ? 'Wird vorbereitet …' : 'Einrichten'}
                </button>
            ) : (
                <>
                    <p className="faint">
                        In der App eintragen — als Schlüssel oder über die Adresse. Beides ist
                        dasselbe Geheimnis.
                    </p>
                    <p>
                        <code className="sieve-code">{enrolment.secret}</code>
                    </p>
                    <p className="faint">
                        <code>{enrolment.uri}</code>
                    </p>
                    <label className="field field-narrow">
                        <span>Code aus der App</span>
                        <input
                            type="text"
                            className="text-input"
                            inputMode="numeric"
                            maxLength={6}
                            value={code}
                            onChange={(event) => {
                                setCode(event.target.value.replace(/\D/g, ''));
                            }}
                        />
                    </label>
                    <Result error={error} done={done} />
                    <div className="row">
                        <button
                            type="button"
                            className="button"
                            disabled={code.length !== 6 || busy}
                            onClick={() => {
                                run(async () => {
                                    await perform({
                                        action: 'totp-enable',
                                        secret: enrolment.secret,
                                        code,
                                    });
                                    setEnrolment(undefined);
                                    setCode('');
                                }, 'Zwei-Faktor ist eingeschaltet.');
                            }}
                        >
                            Einschalten
                        </button>
                        <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => {
                                setEnrolment(undefined);
                                setCode('');
                                clear();
                            }}
                        >
                            Abbrechen
                        </button>
                    </div>
                </>
            )}
            {enrolment === undefined && <Result error={error} done={done} />}
        </section>
    );
}

function Passkeys(): React.JSX.Element {
    const { status, perform } = useAccount();
    const { busy, error, done, run } = useAction();
    const [label, setLabel] = useState('');

    return (
        <section className="settings-block form-stack">
            <h3>Passkeys</h3>
            <p className="faint">
                Ein Passkey kommt <strong>zum Passwort dazu</strong>, er ersetzt es nicht: WebAuthn
                liefert eine Signatur, kein Geheimnis — und aus einer Signatur lässt sich der
                Schlüssel für die lokalen Daten nicht gewinnen. Ein Knopf, der das verspräche, könnte
                es nicht halten.
            </p>

            {status.passkeys.length === 0 ? (
                <p className="muted">Noch keiner registriert.</p>
            ) : (
                <ul className="plain-list">
                    {status.passkeys.map((passkey) => (
                        <li key={passkey.id} className="row">
                            <span>
                                <strong>{passkey.label}</strong>{' '}
                                <span className="faint">
                                    seit {new Date(passkey.addedAt * 1000).toLocaleDateString('de-CH')}
                                </span>
                            </span>
                            <button
                                type="button"
                                className="button button-quiet"
                                disabled={busy}
                                onClick={() => {
                                    run(
                                        () => perform({ action: 'passkey-remove', id: passkey.id }),
                                        'Der Passkey ist entfernt.'
                                    );
                                }}
                            >
                                Entfernen
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            <label className="field">
                <span>Bezeichnung für einen neuen Passkey</span>
                <input
                    type="text"
                    className="text-input"
                    placeholder="z. B. YubiKey oder Laptop"
                    value={label}
                    onChange={(event) => {
                        setLabel(event.target.value);
                    }}
                />
            </label>

            <Result error={error} done={done} />

            <button
                type="button"
                className="button button-secondary"
                disabled={label.trim() === '' || busy}
                onClick={() => {
                    run(async () => {
                        const begun = (await perform({
                            action: 'passkey-register-begin',
                            origin: window.location.origin,
                        })) as { options: Parameters<typeof startRegistration>[0]['optionsJSON'] };
                        const created = await startRegistration({ optionsJSON: begun.options });
                        await perform({
                            action: 'passkey-register-finish',
                            label: label.trim(),
                            response: created,
                            origin: window.location.origin,
                        });
                        setLabel('');
                    }, 'Der Passkey ist registriert.');
                }}
            >
                {busy ? 'Warte auf den Schlüssel …' : 'Passkey hinzufügen'}
            </button>
        </section>
    );
}

function Grace(): React.JSX.Element {
    const { status, perform } = useAccount();
    const { busy, error, done, run } = useAction();
    const [minutes, setMinutes] = useState(String(status.graceMinutes));

    const parsed = Number(minutes);
    const usable = minutes.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1440;

    return (
        <section className="settings-block form-stack">
            <h3>Nachfrist beim Sperren</h3>
            <p className="faint">
                So lange wird der Schlüssel nach dem Sperren noch gehalten. Innerhalb dieser Zeit
                kommst du ohne Passwort zurück und die Verbindung zu Proton bleibt bestehen. Das ist
                eine bewusste Abschwächung für eine echte Bequemlichkeit — <code>0</code> schaltet
                sie ab, und dann ist gesperrt auch wirklich zu.
            </p>

            <label className="field field-narrow">
                <span>Minuten</span>
                <input
                    type="text"
                    className="text-input"
                    inputMode="numeric"
                    value={minutes}
                    onChange={(event) => {
                        setMinutes(event.target.value.replace(/\D/g, ''));
                    }}
                />
                {!usable && minutes.trim() !== '' && (
                    <span className="field-error">Zwischen 0 und 1440 Minuten.</span>
                )}
            </label>

            <Result error={error} done={done} />

            <button
                type="button"
                className="button button-secondary"
                disabled={!usable || busy}
                onClick={() => {
                    run(
                        () => perform({ action: 'grace', minutes: parsed }),
                        parsed === 0
                            ? 'Gespeichert. Sperren wirft den Schlüssel künftig sofort weg.'
                            : `Gespeichert. Der Schlüssel wird nach dem Sperren noch ${String(parsed)} Minuten gehalten.`
                    );
                }}
            >
                Speichern
            </button>
        </section>
    );
}

function Lock(): React.JSX.Element {
    const { perform } = useAccount();
    const { busy, error, run } = useAction();

    return (
        <section className="settings-block form-stack">
            <h3>Sperren</h3>
            <p className="faint">
                „Sperren" hält den Schlüssel für die Nachfrist. „Sofort sperren" wirft ihn weg,
                schliesst die lokale Kopie und beendet die Proton-Sitzung in diesem Prozess — die
                Antwort auf „ich gehe von diesem Rechner weg".
            </p>

            <Result error={error} />

            <div className="row">
                <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                        run(() => perform({ action: 'lock' }), '');
                    }}
                >
                    Sperren
                </button>
                <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={() => {
                        run(() => perform({ action: 'lock', immediate: true }), '');
                    }}
                >
                    Sofort sperren
                </button>
            </div>
        </section>
    );
}
