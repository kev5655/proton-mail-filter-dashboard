import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { argon2id } from '@noble/hashes/argon2.js';
import { AppError } from '@pms/core/errors';

/**
 * The password, the key, and the thing the key opens.
 *
 * The design decision this file exists to express: **the password does not encrypt the data — it
 * unwraps a key that does.** A random 32-byte master key is generated once, at registration, and
 * everything on this machine is encrypted with it: the mailbox database and the stored Proton
 * session. The password protects only a copy of that key.
 *
 * That indirection buys the two things a direct key could not:
 *
 *  - **Changing the password does not re-encrypt anything.** The master key stays; only its
 *    wrapping is redone. Otherwise a password change would mean rewriting a database of somebody's
 *    mail, with all the ways that can be interrupted halfway.
 *  - **A second wrapping can be added later** — a recovery code, a passkey with PRF — without the
 *    data caring.
 *
 * Argon2id rather than a fast hash, and `@noble/hashes` rather than a native module, for the same
 * reasons `packages/store/src/key.ts` gives: memory cost is what makes a GPU farm stop being an
 * advantage, and this runs once per unlock.
 *
 * **There is no password recovery, and that is not an oversight.** Nothing here can decrypt the
 * master key without the password. A forgotten password means deleting the local data and
 * connecting to Proton again — which is a real cost, said plainly in the interface rather than
 * discovered.
 */

/** Comfortably above OWASP's floor. Stored per account, so raising them later is a migration. */
const PARAMS = { t: 3, m: 65_536, p: 1 } as const;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface KdfParams {
    salt: string;
    t: number;
    m: number;
    p: number;
}

export interface WrappedKey {
    iv: string;
    tag: string;
    ciphertext: string;
}

/** Derive the key-encryption key. Never stored, never leaves the process that computed it. */
export function deriveKek(password: string, params: KdfParams): Uint8Array {
    if (password === '') {
        // An empty password derives a perfectly good key, which is exactly the problem: it would
        // protect nothing while looking like it did.
        throw new AppError('ACCOUNT_PASSWORD_EMPTY', {
            message: 'Ohne Passwort gibt es keinen Schlüssel.',
            hint: 'Ein leeres Passwort ergibt einen gültigen Schlüssel, den jeder ableiten kann.',
        });
    }
    return argon2id(new TextEncoder().encode(password), Buffer.from(params.salt, 'base64'), {
        t: params.t,
        m: params.m,
        p: params.p,
        dkLen: KEY_BYTES,
    });
}

export function newKdfParams(): KdfParams {
    return { salt: randomBytes(SALT_BYTES).toString('base64'), ...PARAMS };
}

/**
 * A fresh master secret. The only place one is created.
 *
 * A string rather than raw bytes, and that is not cosmetic: `openDatabase` and the session store
 * both take a passphrase, and an installation that already has data was opened with one that came
 * from 1Password or a prompt. Registering must be able to **adopt** that existing secret rather
 * than mint a new one — a new key would leave the database and the stored session encrypted with
 * something nobody holds any more, which is a mailbox lost to a registration form.
 */
export function newMasterSecret(): string {
    return randomBytes(KEY_BYTES).toString('hex');
}

export function wrapMasterKey(secret: string, kek: Uint8Array): WrappedKey {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
    return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}

/**
 * Unwrap, or say the password was wrong.
 *
 * GCM's authentication tag is what makes a wrong password a clean answer rather than 32 bytes of
 * noise that would go on to fail somewhere far away — the database refusing to open, a session file
 * that will not parse. The failure belongs here, where it can be named.
 */
export function unwrapMasterKey(wrapped: WrappedKey, kek: Uint8Array): string {
    try {
        const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    } catch (cause) {
        throw new AppError('ACCOUNT_PASSWORD_WRONG', {
            message: 'Passwort falsch.',
            hint:
                'Es gibt keine Wiederherstellung — der Schlüssel für deine lokalen Daten hängt an ' +
                'diesem Passwort. Ohne es hilft nur: lokale Daten löschen und neu mit Proton verbinden.',
            cause,
        });
    }
}

/**
 * Encrypt something small with the master key.
 *
 * Used for the TOTP secret, which has to survive between logins and must not be readable without
 * the password — otherwise somebody with the account file could generate valid codes and would have
 * defeated the second factor without touching the first.
 */
/**
 * Encrypt something small with the master secret.
 *
 * The secret is an arbitrary-length string, so it is hashed to 32 bytes before being used as a key
 * — AES-256 needs exactly that, and an adopted passphrase is whatever somebody typed.
 */
export function sealWithMasterKey(plaintext: string, secret: string): WrappedKey {
    return wrapMasterKey(plaintext, keyFromSecret(secret));
}

export function openWithMasterKey(sealed: WrappedKey, secret: string): string {
    return unwrapMasterKey(sealed, keyFromSecret(secret));
}

function keyFromSecret(secret: string): Uint8Array {
    return createHash('sha256').update(secret, 'utf8').digest();
}

/** Constant-time comparison, for anything that is compared rather than decrypted. */
export function sameSecret(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}
