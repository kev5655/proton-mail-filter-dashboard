import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

import { assertWithPrf } from '../passkey.js';

import { useAccount } from '../account.js';
import { deviceIsKnown, rememberDevice } from '../device.js';

/**
 * The first screen, and on most days the only one that asks for anything.
 *
 * Two shapes, and which one appears is not a preference: an installation either has an account or
 * it does not. The first run creates one, and creating one is the moment the key for the local data
 * comes into existence — which is why this screen says, before the password is chosen, that there
 * is no way back from losing it. A recovery path would have to store the key somewhere a password
 * does not protect, which is the whole thing this is for.
 *
 * **Where a passkey can open the account, it is the first thing offered and the password is the
 * fallback.** Not because it is more convenient — because it is the stronger of the two: the secret
 * never leaves the authenticator, there is nothing to type, and nothing to phish.
 *
 * A passkey can only do that once it has been *released* for it, and that release requires the vault
 * to already be open, so a passkey cannot enrol itself. A passkey that has not been released is what
 * it always was — a second factor beside the password — and the screen says so in as many words,
 * because the failure it otherwise produces is „mein Passkey funktioniert nicht" with nothing on
 * screen to contradict it.
 *
 * **It does not assume the visitor is the account holder.** This page is reachable by anybody who
 * can reach the port, so it greets nobody by name until this browser has actually opened the account
 * before. Recognition otherwise happens in the authenticator, where it belongs: pressing the button
 * either produces a credential this server knows or it does not, and the screen has asserted nothing
 * either way.
 */
export function LockScreen(): React.JSX.Element {
    const { status } = useAccount();
    /*
     * Whether the second form is showing.
     *
     * There was no way to reach it at all once an account existed, which meant an installation
     * could hold several Proton accounts and offer no way to create the second one — the whole
     * substrate underneath was reachable only by deleting the first account's files. The server has
     * always handled it correctly: registering while one account exists creates a *new directory*,
     * closes the open one and registers there, so nothing of the first is touched.
     *
     * Local state rather than a route, because it is a choice about this screen and nothing else
     * should be able to land somebody on it.
     */
    const [adding, setAdding] = useState(false);

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
                {status.registered && !adding ? (
                    <>
                        <Unlock />
                        {/*
                          * Quiet, and below the password. It is not what anybody came here to do —
                          * and it says „weiteres", so it cannot be mistaken for a way to recover
                          * the account whose password somebody has just failed to remember. There
                          * is no such way, by design.
                          */}
                        <button
                            type="button"
                            className="button button-quiet lock-secondary"
                            onClick={() => {
                                setAdding(true);
                            }}
                        >
                            Ein weiteres Konto anlegen
                        </button>
                    </>
                ) : (
                    <Register
                        {...(status.registered
                            ? {
                                  onCancel: () => {
                                      setAdding(false);
                                  },
                              }
                            : {})}
                    />
                )}
            </div>
        </div>
    );
}

function Register({ onCancel }: { onCancel?: () => void }): React.JSX.Element {
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
            className="form-stack"
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
            <h1>{onCancel === undefined ? 'Konto anlegen' : 'Weiteres Konto anlegen'}</h1>
            {onCancel === undefined ? null : (
                <p className="notice notice-info">
                    Das neue Konto bekommt ein eigenes Verzeichnis mit eigener Datenbank, eigener
                    Proton-Verbindung und eigenem Passwort. Vom bisherigen wird nichts übernommen und
                    nichts angefasst — <strong>es wird beim Anlegen geschlossen</strong>, und du
                    kommst mit seinem Namen und seinem Passwort wieder hinein.
                </p>
            )}
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
            {onCancel === undefined ? null : (
                <button
                    type="button"
                    className="button button-quiet"
                    disabled={busy}
                    onClick={onCancel}
                >
                    Zurück
                </button>
            )}
            <p className="faint">
                Zwei-Faktor und Passkeys lassen sich danach in den Einstellungen einschalten.
            </p>
        </form>
    );
}

function Unlock(): React.JSX.Element {
    const { status, perform } = useAccount();
    const [password, setPassword] = useState('');
    /*
     * Which account, where there is more than one.
     *
     * Typed rather than picked from a list, and that is the deliberate half: a lock screen that
     * enumerates the accounts tells whoever opened the page which mailboxes live on this machine,
     * before they have proven they can open any of them.
     */
    const [account, setAccount] = useState('');
    const [totp, setTotp] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();
    /** Whether this browser has opened this account before. Decides the greeting and nothing else. */
    const [known] = useState(deviceIsKnown);
    /*
     * Whether the password half is on screen.
     *
     * Where a passkey can open the account it is the offer, and the password is one click away
     * rather than in front of it. It is never *gone*: an authenticator can be forgotten at home, be
     * out of battery, or refuse, and a lock screen with no way in but a device somebody does not
     * have on them is a lock-out with better manners.
     */
    const [withPassword, setWithPassword] = useState(status.passkeyUnlock !== true);

    const submit = (passkey?: unknown): void => {
        setError(undefined);
        setBusy(true);
        void perform({
            action: 'unlock',
            password,
            totp,
            account,
            origin: window.location.origin,
            ...(passkey === undefined ? {} : { passkey }),
        })
            .then(() => {
                rememberDevice();
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
    /**
     * Opening with the passkey alone.
     *
     * No password field is involved and none is sent. What stands in for it is the authenticator
     * plus the user verification it was told to require — and the key really is unwrapped by what
     * the PRF extension produced, rather than a password being waived after a signature.
     *
     * The account name still travels, because on an installation with several accounts the server
     * has to know which one to try before it can try anything.
     */
    const withPasskeyOnly = (): void => {
        setError(undefined);
        setBusy(true);
        void (async () => {
            try {
                const begun = (await perform({
                    action: 'passkey-login-begin',
                    origin: window.location.origin,
                    forUnlock: true,
                })) as { options: unknown };
                const { response, prfOutput } = await assertWithPrf(begun.options);
                await perform({
                    action: 'passkey-unlock',
                    response,
                    prfOutput,
                    origin: window.location.origin,
                    account,
                });
                rememberDevice();
            } catch (cause) {
                setError(
                    cause instanceof Error ? cause.message : 'Der Passkey wurde nicht akzeptiert.'
                );
            } finally {
                setBusy(false);
            }
        })();
    };

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
            className="form-stack"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <h1>Anmelden</h1>
            <p className="muted">
                {status.needsAccountName === true
                    ? 'Auf diesem Rechner liegt mehr als ein Konto. Jedes hat seinen eigenen Schlüssel — solange dieses hier offen ist, bleiben die anderen verschlüsselt.'
                    : /*
                       * The name only where this browser has opened the account before.
                       *
                       * Anybody who can reach the port can load this page, and „angemeldet wird als
                       * …" hands them the account's name for having done nothing but ask. On a
                       * device that has unlocked before, the holder has demonstrably sat here and
                       * the sentence tells them nothing they did not bring with them.
                       */
                      known && status.username !== undefined
                      ? `Angemeldet wird als ${status.username}. Die lokale Kopie ist verschlüsselt und wird erst danach geöffnet.`
                      : 'Die lokale Kopie ist verschlüsselt und wird erst nach der Anmeldung geöffnet.'}
            </p>

            {status.passkeyUnlock === true && (
                <div className="form-stack lock-primary">
                    <button
                        type="button"
                        className="button button-wide"
                        disabled={busy}
                        onClick={withPasskeyOnly}
                    >
                        {busy ? 'Warte auf den Schlüssel …' : 'Mit Passkey aufschliessen'}
                    </button>
                    <p className="faint">
                        Der Schlüssel wird dabei wirklich aus dem Passkey entpackt — es wird kein
                        Passwort übergangen. Er verlangt deine Bestätigung am Gerät.
                    </p>
                    {!withPassword && (
                        <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => {
                                setWithPassword(true);
                            }}
                        >
                            Stattdessen Passwort eingeben
                        </button>
                    )}
                </div>
            )}

            {/*
             * A passkey that is only a second factor, and the one sentence that was missing.
             *
             * Without it the screen offers no passkey button, gives no reason, and reads as „der
             * Passkey funktioniert nicht". It is not broken: it has not been released for
             * unlocking, and releasing it needs the vault open — which is the rule that stops a
             * passkey enrolling itself, so the way through it really is the password, once.
             */}
            {status.hasPasskeys && status.passkeyUnlock !== true && (
                <p className="notice notice-info">
                    <strong>Dein Passkey ist hier nur der zweite Faktor.</strong> Zum Aufschliessen
                    ohne Passwort muss er einmal freigegeben werden, und das geht nur bei offenem
                    Tresor — ein Passkey kann sich nicht selbst dazu befördern. Also: einmal mit dem
                    Passwort aufschliessen, dann unter <strong>Einstellungen → Konto → Passkeys</strong>{' '}
                    auf <strong>„Ohne Passwort aufschliessen"</strong>. Danach ist der Passkey hier
                    der erste Knopf.
                </p>
            )}

            {status.withinGrace && (
                <div className="notice notice-info form-stack">
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

            {status.needsAccountName === true && (
                <label className="field">
                    <span>Konto</span>
                    <input
                        type="text"
                        className="text-input"
                        autoComplete="username"
                        autoCapitalize="none"
                        value={account}
                        onChange={(event) => {
                            setAccount(event.target.value);
                        }}
                    />
                </label>
            )}

            {withPassword && (
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
            )}

            {withPassword && status.requiresTotp && (
                <label className="field field-narrow">
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

            {withPassword && (
            <div className="row">
                <button
                    type="submit"
                    className="button"
                    disabled={password === '' || busy || (status.needsAccountName === true && account.trim() === '')}
                >
                    {busy ? 'Wird geprüft …' : 'Aufschliessen'}
                </button>
                {status.hasPasskeys && (
                    <button
                        type="button"
                        className="button button-secondary"
                        disabled={password === '' || busy}
                        onClick={withPasskey}
                    >
                        Passwort und Passkey
                    </button>
                )}
            </div>
            )}

            {withPassword && status.hasPasskeys && status.passkeyUnlock !== true && (
                <p className="faint">
                    „Passwort und Passkey" verlangt beides. Der Passkey kommt hier zum Passwort dazu,
                    er ersetzt es nicht: aus einer WebAuthn-Signatur lässt sich kein Schlüssel
                    gewinnen, und der Schlüssel ist genau das, was das Passwort aufschliesst.
                </p>
            )}
        </form>
    );
}
