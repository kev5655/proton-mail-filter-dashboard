import { AppError, isAppError, PROTON_ERROR_CODE, ProtonApiError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { getSrp } from '@protontech/crypto/srp';
import { z } from 'zod';

import { initCrypto } from './crypto.js';
import type { ProtonHttp, ProtonSession } from './http.js';
import {
    authResponseSchema,
    infoResponseSchema,
    sessionResponseSchema,
    TWO_FACTOR_FIDO2,
    TWO_FACTOR_TOTP,
    type AuthResponse,
} from './schemas.js';

const log = getLogger('proton-auth');

/**
 * SRP login against Proton.
 *
 * SRP means the password never leaves this process — not even in encrypted form. The client proves
 * it knows the password by arithmetic, and in return proves the *server* knows the verifier. That
 * second half is not optional: skipping the server-proof check would leave the login open to an
 * impostor endpoint, so a mismatch aborts hard.
 *
 * The cryptography itself is Proton's own `@protontech/crypto`, not a reimplementation.
 *
 * The handshake has three steps, not two. Before `auth/info` comes `auth/v4/sessions`, which opens
 * an *unauthenticated* session — tokens with no user behind them — and the two SRP calls then run
 * inside it, carrying its `x-pm-uid`. Proton's own client has always done this; we did not, and
 * that is what earned code 2028. A credential submission arriving with no session context is
 * shaped exactly like credential stuffing, whatever the credentials turn out to be. The account was
 * never locked: the same account signed in through a browser at the same moment this was refused.
 */

export interface LoginCredentials {
    username: string;
    password: string;
}

export type TwoFactorPrompt = () => Promise<string>;

export interface LoginResult {
    session: ProtonSession;
    userId: string;
    scope: string;
}

export async function login(
    http: ProtonHttp,
    credentials: LoginCredentials,
    promptTwoFactor: TwoFactorPrompt
): Promise<LoginResult> {
    // getSrp verifies the PGP signature on Proton's modulus, so the crypto endpoint must exist.
    initCrypto();

    await openUnauthSession(http);

    const info = await http.request(
        {
            method: 'POST',
            path: 'core/v4/auth/info',
            body: { Username: credentials.username, Intent: 'Proton' },
        },
        infoResponseSchema
    );

    const { clientEphemeral, clientProof, expectedServerProof } = await getSrp(
        {
            Version: info.Version,
            Modulus: info.Modulus,
            ServerEphemeral: info.ServerEphemeral,
            Username: credentials.username,
            Salt: info.Salt,
        },
        { username: credentials.username, password: credentials.password }
    );

    let auth: AuthResponse;
    try {
        auth = await http.request(
            {
                method: 'POST',
                path: 'core/v4/auth',
                body: {
                    Username: credentials.username,
                    ClientEphemeral: clientEphemeral,
                    ClientProof: clientProof,
                    SRPSession: info.SRPSession,
                    PersistentCookies: 0,
                },
            },
            authResponseSchema
        );
    } catch (cause) {
        throw describeLoginFailure(cause, info.Version);
    }

    if (auth.ServerProof !== expectedServerProof) {
        // Either Proton changed the handshake or we are not talking to Proton. Both mean stop.
        throw new AppError('PROTON_AUTH_FAILED', {
            message: 'Proton hat sich nicht korrekt ausgewiesen — die Anmeldung wurde abgebrochen.',
            hint: 'Bitte melden. Das ist kein normaler Fehlerfall und wurde bewusst hart abgebrochen.',
            context: { reason: 'server_proof_mismatch' },
        });
    }

    const session: ProtonSession = {
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
    };
    http.setSession(session);

    if (auth.TwoFactor !== 0) {
        await completeTwoFactor(http, auth.TwoFactor, promptTwoFactor);
    }

    log.info(
        { userId: auth.UserID, twoFactor: auth.TwoFactor, authVersion: info.Version },
        'logged in to proton'
    );
    return { session, userId: auth.UserID, scope: auth.Scope };
}

/**
 * Open the unauthenticated session that the SRP handshake runs inside.
 *
 * This is the only call of the whole login that is genuinely anonymous. Everything after it carries
 * the UID returned here, which is what makes the login look like one client having one conversation
 * instead of a bare pair of credentials arriving out of nowhere.
 *
 * Proton's web client attaches a `Payload` here — a device challenge collected in the browser. It
 * is optional in the API and we deliberately send none: fabricating browser telemetry would be
 * pretending to be a browser, which is the one thing this client does not do.
 *
 * A failure here aborts. Falling back to the old anonymous shape would restore exactly the request
 * pattern Proton flagged, and would spend a login attempt to do it.
 */
async function openUnauthSession(http: ProtonHttp): Promise<void> {
    let response;
    try {
        response = await http.request(
            {
                method: 'POST',
                path: 'auth/v4/sessions',
                body: {},
                anonymous: true,
                // Required of clients that are not covered by Proton's minimum-version list.
                headers: { 'x-enforce-unauthsession': 'true' },
            },
            sessionResponseSchema
        );
    } catch (cause) {
        throw new AppError('PROTON_AUTH_FAILED', {
            message: 'Proton hat keine Sitzung für die Anmeldung eröffnet.',
            hint:
                'Die Anmeldung wurde abgebrochen, bevor Zugangsdaten gesendet wurden — es zählt ' +
                'also kein Fehlversuch. Ohne diese Sitzung wertet Proton den Login als verdächtig.',
            context: { step: 'auth/v4/sessions' },
            cause,
        });
    }

    http.setSession({
        uid: response.UID,
        accessToken: response.AccessToken,
        refreshToken: response.RefreshToken,
    });
    log.debug('unauthenticated session opened for the login handshake');
}

/**
 * Turn a rejected login into something actionable.
 *
 * The first version of this replaced every failure with "check username and password". That reads
 * as helpful and is actively harmful: when the real cause was an empty password from a broken
 * prompt, and later a client Proton would not accept at all, the message pointed at the one thing
 * that was fine. Proton's own code and message now survive into the error, and only code 8002
 * actually claims the password was wrong.
 */
export function describeLoginFailure(cause: unknown, authVersion: number): AppError {
    if (!(cause instanceof ProtonApiError)) {
        return isAppError(cause)
            ? cause
            : new AppError('PROTON_AUTH_FAILED', {
                  message: 'Anmeldung bei Proton fehlgeschlagen.',
                  context: { authVersion },
                  cause,
              });
    }

    const shared = { authVersion, protonCode: cause.protonCode, protonMessage: cause.protonMessage };

    if (cause.protonCode === PROTON_ERROR_CODE.WRONG_PASSWORD) {
        return new AppError('PROTON_AUTH_WRONG_PASSWORD', {
            message: 'Proton meldet: Benutzername oder Passwort ist falsch.',
            hint:
                'Bei Konten mit zwei Passwörtern ist hier das Login-Passwort gemeint, nicht das ' +
                'Mailbox-Passwort. Nach mehreren Fehlversuchen sperrt Proton kurzzeitig.',
            context: shared,
            cause,
        });
    }

    if (cause.protonCode === PROTON_ERROR_CODE.HUMAN_VERIFICATION_REQUIRED) {
        return new AppError('PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED', {
            message: 'Proton verlangt für diese Anmeldung eine menschliche Verifizierung (CAPTCHA).',
            hint:
                'Das lässt sich hier nicht lösen — dafür wäre Protons Verifizierungs-Widget nötig. ' +
                'Einmal regulär über mail.proton.me anmelden kann die Anforderung entschärfen.',
            context: { ...shared, details: cause.context['details'] },
            cause,
        });
    }

    if (cause.protonCode === PROTON_ERROR_CODE.ACCOUNT_LOCKED) {
        return new AppError('PROTON_AUTH_FAILED', {
            message: `Proton hat die Anmeldung abgelehnt: ${cause.protonMessage ?? '2028'}`,
            hint:
                'Das trifft die Anmeldung, nicht das Konto: dasselbe Konto kommt über ' +
                'mail.proton.me herein. Was diesem Aufruf gegenüber dem Webclient fehlt, ist ' +
                'dessen Browser-Challenge (`Payload`) — Telemetrie, die nur ein Browser ehrlich ' +
                'erzeugen kann. Nachbauen hiesse, einen Browser vorzutäuschen. Nicht erneut ' +
                'versuchen; der Weg führt über Protons Support.',
            context: { ...shared, httpStatus: cause.httpStatus, step: 'core/v4/auth' },
            cause,
        });
    }

    return new AppError('PROTON_AUTH_FAILED', {
        message: `Proton hat die Anmeldung abgelehnt: ${cause.protonMessage ?? `HTTP ${cause.httpStatus}`}`,
        hint: `Protons Fehlercode: ${cause.protonCode ?? 'keiner'}. Das ist Protons Wortlaut, nicht unsere Deutung.`,
        context: { ...shared, httpStatus: cause.httpStatus, details: cause.context['details'] },
        cause,
    });
}

async function completeTwoFactor(http: ProtonHttp, twoFactor: number, prompt: TwoFactorPrompt): Promise<void> {
    const hasTotp = (twoFactor & TWO_FACTOR_TOTP) !== 0;
    if (!hasTotp) {
        const only = (twoFactor & TWO_FACTOR_FIDO2) !== 0 ? 'ein Sicherheitsschlüssel (FIDO2)' : 'ein unbekanntes Verfahren';
        throw new AppError('PROTON_AUTH_2FA_REQUIRED', {
            message: `Für dieses Konto ist ${only} als zweiter Faktor eingerichtet.`,
            hint: 'FIDO2 wird noch nicht unterstützt. Bis dahin bitte TOTP als zweiten Faktor aktivieren.',
            context: { twoFactor },
        });
    }

    const code = await prompt();
    try {
        await http.request(
            { method: 'POST', path: 'core/v4/auth/2fa', body: { TwoFactorCode: code } },
            // The 2FA response carries only the envelope we care about.
            z.object({ Code: z.number() })
        );
    } catch (cause) {
        throw new AppError('PROTON_AUTH_2FA_INVALID', {
            message: 'Der Zwei-Faktor-Code wurde von Proton abgelehnt.',
            hint: 'Code neu vom Authenticator ablesen — er ist nur ~30 Sekunden gültig.',
            cause,
        });
    }
}

/**
 * Exchange the refresh token for a new access token.
 *
 * This is the whole reason a stored session is worth having: a session that can be refreshed does
 * not need a login, and a login is what Proton's abuse detection reacts to. Proton rotates the
 * refresh token on every use, so the caller must persist the result.
 */
export async function refreshSession(http: ProtonHttp, session: ProtonSession): Promise<ProtonSession> {
    http.setSession(session);
    const response = await http.request(
        {
            method: 'POST',
            path: 'auth/refresh',
            body: {
                ResponseType: 'token',
                GrantType: 'refresh_token',
                RefreshToken: session.refreshToken,
                RedirectURI: 'https://protonmail.com',
            },
        },
        refreshResponseSchema
    );

    const refreshed: ProtonSession = {
        uid: response.UID ?? session.uid,
        accessToken: response.AccessToken,
        refreshToken: response.RefreshToken,
    };
    http.setSession(refreshed);
    log.info({ uid: '[redacted]' }, 'session refreshed');
    return refreshed;
}

const refreshResponseSchema = z.object({
    Code: z.number(),
    AccessToken: z.string(),
    RefreshToken: z.string(),
    UID: z.string().optional(),
    ExpiresIn: z.number().optional(),
});
