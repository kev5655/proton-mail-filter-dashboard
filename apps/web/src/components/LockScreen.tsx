import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

import { useAccount } from '../account.js';

/**
 * The first screen, and on most days the only one that asks for anything.
 *
 * Two shapes, and which one appears is not a preference: an installation either has an account or
 * it does not. The first run creates one, and creating one is the moment the key for the local data
 * comes into existence — which is why this screen says, before the password is chosen, that there
 * is no way back from losing it. A recovery path would have to store the key somewhere a password
 * does not protect, which is the whole thing this is for.
 *
 * A passkey is offered as a *second* factor and never as a replacement for the password. WebAuthn
 * hands back a signature, not a secret, so there is nothing in it to unwrap a key with — and a
 * button labelled „Passkey" that then asks for a password anyway reads as a bug unless the screen
 * says why.
 */
export function LockScreen(): React.JSX.Element {
    const { status } = useAccount();

    return (
        <div className="lock-screen">
            <div className="lock-card">
                <div className="lock-mark" aria-hidden="true">
                    <svg
                        viewBox="0 0 24 24"
                        width="28"
                        height="28"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                    >
                        <rect x="4" y="10.5" width="16" height="10" rx="2" />
                        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                    </svg>
                </div>
                {status.registered ? <Unlock /> : <Register />}
            </div>
        </div>
    );
}

function Register(): React.JSX.Element {
    const { perform } = useAccount();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const mismatch = repeat !== '' && repeat !== password;
    const usable = username.trim() !== '' && password.length >= 8 && !mismatch && repeat !== '';

    return (
        <form
            className="stack"
            onSubmit={(event) => {
                event.preventDefault();
                setError(undefined);
                setBusy(true);
                void perform({ action: 'register', username: username.trim(), password })
                    .catch((cause: Error) => {
                        setError(cause.message);
                    })
                    .finally(() => {
                        setBusy(false);
                    });
            }}
        >
            <h1>Konto anlegen</h1>
            <p className="muted">
                Dieses Passwort ist der Schlüssel für alles, was auf diesem Rechner liegt — die
                Kopie deines Postfachs und die gespeicherte Proton-Sitzung. Ohne das Passwort ist
                der Ordner <code>data/</code> unlesbar, auch für jemanden, der ihn kopiert.
            </p>
            <p className="notice notice-warning">
                <strong>Es gibt keine Wiederherstellung.</strong> Vergisst du das Passwort, hilft
                nur: lokale Daten löschen und neu mit Proton verbinden. Ein Weg zurück müsste den
                Schlüssel irgendwo hinlegen, wo ihn kein Passwort schützt — und dann wäre das
                Passwort keins.
            </p>

            <label className="field">
                <span>Benutzername oder E-Mail</span>
                <input
                    type="text"
                    className="text-input"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => {
                        setUsername(event.target.value);
                    }}
                />
                <span className="faint">Nur eine Bezeichnung. Sie wird nirgendwohin geschickt.</span>
            </label>

            <label className="field">
                <span>Passwort</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                />
                <span className="faint">
                    Mindestens acht Zeichen. Länger ist hier mehr wert als komplizierter.
                </span>
            </label>

            <label className="field">
                <span>Passwort wiederholen</span>
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

            {error !== undefined && <p className="notice notice-danger">{error}</p>}

            <button type="submit" className="button" disabled={!usable || busy}>
                {busy ? 'Wird angelegt …' : 'Konto anlegen'}
            </button>
            <p className="faint">
                Zwei-Faktor und Passkeys lassen sich danach in den Einstellungen einschalten.
            </p>
        </form>
    );
}

function Unlock(): React.JSX.Element {
    const { status, perform } = useAccount();
    const [password, setPassword] = useState('');
    const [totp, setTotp] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const submit = (passkey?: unknown): void => {
        setError(undefined);
        setBusy(true);
        void perform({
            action: 'unlock',
            password,
            totp,
            origin: window.location.origin,
            ...(passkey === undefined ? {} : { passkey }),
        })
            .catch((cause: Error) => {
                setError(cause.message);
            })
            .finally(() => {
                setBusy(false);
            });
    };

    /*
     * The passkey ceremony, and then the ordinary unlock.
     *
     * The challenge comes from the server and goes back to the server; this page never invents one
     * and never chooses which credential counts. What it contributes is the part only a browser can
     * do — talking to the authenticator.
     */
    const withPasskey = (): void => {
        setError(undefined);
        setBusy(true);
        void (async () => {
            try {
                const begun = (await perform({
                    action: 'passkey-login-begin',
                    origin: window.location.origin,
                })) as { options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };
                const assertion = await startAuthentication({ optionsJSON: begun.options });
                submit(assertion);
            } catch (cause) {
                setError(
                    cause instanceof Error ? cause.message : 'Der Passkey wurde nicht akzeptiert.'
                );
                setBusy(false);
            }
        })();
    };

    return (
        <form
            className="stack"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <h1>Anmelden</h1>
            <p className="muted">
                {status.username === undefined
                    ? 'Die lokale Kopie ist verschlüsselt und wird erst nach der Anmeldung geöffnet.'
                    : `Angemeldet wird als ${status.username}. Die lokale Kopie ist verschlüsselt und wird erst danach geöffnet.`}
            </p>

            {status.withinGrace && (
                <div className="notice notice-info">
                    <p>
                        Der Schlüssel wird noch gehalten — die Nachfrist läuft. Du kommst ohne
                        Passwort zurück, und die Verbindung zu Proton besteht weiter.
                    </p>
                    <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => {
                            setError(undefined);
                            setBusy(true);
                            void perform({ action: 'resume' })
                                .catch((cause: Error) => {
                                    setError(cause.message);
                                })
                                .finally(() => {
                                    setBusy(false);
                                });
                        }}
                    >
                        Weiter ohne Passwort
                    </button>
                </div>
            )}

            <label className="field">
                <span>Passwort</span>
                <input
                    type="password"
                    className="text-input"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                />
            </label>

            {status.requiresTotp && (
                <label className="field">
                    <span>Code aus der Authenticator-App</span>
                    <input
                        type="text"
                        className="text-input"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={totp}
                        onChange={(event) => {
                            setTotp(event.target.value.replace(/\D/g, ''));
                        }}
                    />
                </label>
            )}

            {error !== undefined && <p className="notice notice-danger">{error}</p>}

            <button type="submit" className="button" disabled={password === '' || busy}>
                {busy ? 'Wird geprüft …' : 'Aufschliessen'}
            </button>

            {status.hasPasskeys && (
                <>
                    <button
                        type="button"
                        className="button button-secondary"
                        disabled={password === '' || busy}
                        onClick={withPasskey}
                    >
                        Passwort und Passkey
                    </button>
                    <p className="faint">
                        Der Passkey kommt zum Passwort dazu, er ersetzt es nicht: aus einer
                        WebAuthn-Signatur lässt sich kein Schlüssel gewinnen, und der Schlüssel ist
                        genau das, was das Passwort aufschliesst.
                    </p>
                </>
            )}
        </form>
    );
}
