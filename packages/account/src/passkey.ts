import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

import type { StoredPasskey } from './record.js';

const log = getLogger('account');

/**
 * Passkeys, through a library rather than by hand.
 *
 * This is the one part of the account that is not implemented here, and the reason is worth stating
 * rather than implying: verifying a WebAuthn response means parsing CBOR, decoding COSE keys,
 * checking attestation statements and validating flags and counters. Getting any of it subtly wrong
 * produces a login that *works* and proves nothing — which is the failure mode you cannot test your
 * way out of, because the happy path looks identical. TOTP is thirty lines with published test
 * vectors; this is not that, so it uses `@simplewebauthn/server`.
 *
 * **A passkey is a second factor by default, and can become the key.** Ordinary WebAuthn produces a
 * signature, not a secret, so there is nothing in it to unwrap a key with — which is why for most of
 * this project's life the password was always required as well.
 *
 * The **PRF extension** changes that, and only that. It returns 32 bytes that are deterministic for
 * (credential, salt) and that nobody can compute without the authenticator, and `vault-key.ts` was
 * always shaped to take a second wrapping. A passkey that has been made an unlock method carries
 * one; a passkey that has not is exactly what it was before.
 *
 * Two rules follow and both are enforced here rather than described:
 *
 *  - **Unlocking with a passkey requires user verification.** Possession alone must not open a
 *    mailbox, and while the passkey was only a second factor `preferred` was enough. It is not any
 *    more, so the unlock path passes `requireUserVerification: true`.
 *  - **Not every authenticator can do it.** Where the browser returns no PRF result, nothing is
 *    silently downgraded: the passkey stays a second factor and the screen says so.
 *
 * The relying party is this machine. `localhost` is treated as a secure origin by browsers
 * precisely so that a locally served page can use WebAuthn without a certificate.
 */

const RELYING_PARTY_ID = 'localhost';
const RELYING_PARTY_NAME = 'Proton Mail Sorter';

export interface PasskeyChallenge {
    challenge: string;
    /** Passed straight to the browser's `navigator.credentials` call. */
    options: unknown;
}

export async function startPasskeyRegistration(
    username: string,
    existing: readonly StoredPasskey[],
    origin: string
): Promise<PasskeyChallenge> {
    const options = await generateRegistrationOptions({
        rpName: RELYING_PARTY_NAME,
        rpID: rpIdFor(origin),
        userName: username,
        // Not stored on the authenticator as anything meaningful: this installation has exactly one
        // account, so the id is a constant rather than a user identifier that could travel.
        userID: new TextEncoder().encode('pms-local-account'),
        attestationType: 'none',
        // So the same key cannot be registered twice and silently shadow itself.
        excludeCredentials: existing.map((passkey) => ({
            id: passkey.id,
            transports: passkey.transports as never,
        })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        // Announced at registration so an authenticator that can do it enables the capability then.
        // The output is not read here — browsers are inconsistent about returning it from `create()`
        // — so it is fetched by a `get()` afterwards, which is the reliable path.
        extensions: { prf: {} } as never,
    });
    return { challenge: options.challenge, options };
}

export async function finishPasskeyRegistration(
    response: unknown,
    challenge: string,
    origin: string,
    label: string
): Promise<StoredPasskey> {
    const verification = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpIdFor(origin),
        requireUserVerification: false,
    });

    if (!verification.verified || verification.registrationInfo === undefined) {
        throw new AppError('ACCOUNT_SECOND_FACTOR_WRONG', {
            message: 'Der Passkey liess sich nicht bestätigen.',
            hint: 'Es wurde nichts gespeichert. Noch einmal versuchen, oder einen anderen Schlüssel nehmen.',
        });
    }

    const credential = verification.registrationInfo.credential;
    log.info({ id: credential.id.slice(0, 8) }, 'passkey registered');

    return {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: (credential.transports ?? []) as string[],
        label,
        addedAt: Math.floor(Date.now() / 1000),
    };
}

export async function startPasskeyLogin(
    passkeys: readonly StoredPasskey[],
    origin: string,
    /**
     * The PRF salt, when this assertion is meant to produce key material.
     *
     * Absent for the second-factor use, where no key is being unwrapped and asking for a PRF output
     * would be asking the authenticator for a secret nothing needs.
     */
    prfSalt?: string | undefined
): Promise<PasskeyChallenge> {
    const options = await generateAuthenticationOptions({
        rpID: rpIdFor(origin),
        allowCredentials: passkeys.map((passkey) => ({
            id: passkey.id,
            transports: passkey.transports as never,
        })),
        // Required where the passkey *is* the key: possession alone must not open a mailbox.
        userVerification: prfSalt === undefined ? 'preferred' : 'required',
        ...(prfSalt === undefined
            ? {}
            : { extensions: { prf: { eval: { first: prfSalt } } } as never }),
    });
    return { challenge: options.challenge, options };
}

/**
 * Verify a login, and report the new signature counter.
 *
 * The counter is the one piece of state a passkey login leaves behind: an authenticator that
 * increments it lets a *cloned* credential be spotted, because the clone's counter falls behind.
 * The caller has to store what comes back, or that check quietly stops working.
 */
export async function finishPasskeyLogin(
    response: unknown,
    challenge: string,
    origin: string,
    passkeys: readonly StoredPasskey[],
    /** True where the passkey is unwrapping the key rather than accompanying a password. */
    requireUserVerification = false
): Promise<{ id: string; counter: number }> {
    const id = (response as { id?: string }).id ?? '';
    const known = passkeys.find((passkey) => passkey.id === id);
    if (known === undefined) {
        throw new AppError('ACCOUNT_SECOND_FACTOR_WRONG', {
            message: 'Dieser Passkey gehört nicht zu diesem Konto.',
            hint: 'Registriert sind nur die Schlüssel, die unter Einstellungen aufgeführt sind.',
        });
    }

    const verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpIdFor(origin),
        credential: {
            id: known.id,
            publicKey: new Uint8Array(Buffer.from(known.publicKey, 'base64url')),
            counter: known.counter,
            transports: known.transports as never,
        },
        requireUserVerification,
    });

    if (!verification.verified) {
        throw new AppError('ACCOUNT_SECOND_FACTOR_WRONG', {
            message: 'Der Passkey wurde nicht akzeptiert.',
            hint: 'Es wurde nichts aufgeschlossen.',
        });
    }

    return { id: known.id, counter: verification.authenticationInfo.newCounter };
}

/**
 * The relying party id, derived from the origin the page was actually served from.
 *
 * Hardcoding `localhost` breaks the moment somebody reaches the dashboard as `127.0.0.1`, and a
 * passkey registered against one is not offered for the other — WebAuthn scopes credentials to the
 * RP id, deliberately and strictly.
 */
export function rpIdFor(origin: string): string {
    try {
        return new URL(origin).hostname;
    } catch {
        return RELYING_PARTY_ID;
    }
}
