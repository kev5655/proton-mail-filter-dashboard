// Side-effect import, and it must come first — see polyfill.ts.
import './polyfill.js';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { getSrp } from '@protontech/crypto/srp';
import { z } from 'zod';

import type { ProtonHttp, ProtonSession } from './http.js';
import {
    authResponseSchema,
    infoResponseSchema,
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
    const info = await http.request(
        {
            method: 'POST',
            path: 'core/v4/auth/info',
            body: { Username: credentials.username, Intent: 'Proton' },
            anonymous: true,
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
                anonymous: true,
            },
            authResponseSchema
        );
    } catch (cause) {
        throw new AppError('PROTON_AUTH_FAILED', {
            message: 'Anmeldung bei Proton fehlgeschlagen.',
            hint: 'Benutzername und Passwort prüfen. Nach mehreren Fehlversuchen sperrt Proton kurzzeitig.',
            context: { username: '[redacted]' },
            cause,
        });
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

    log.info({ userId: auth.UserID, twoFactor: auth.TwoFactor }, 'logged in to proton');
    return { session, userId: auth.UserID, scope: auth.Scope };
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
