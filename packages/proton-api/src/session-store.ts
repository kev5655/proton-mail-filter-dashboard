import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { AppError } from '@pms/core/errors';
import { writePrivateFile } from '@pms/core/private-file';
import { getLogger } from '@pms/core/logger';

import type { ProtonSession } from './http.js';

const log = getLogger('session-store');

/**
 * Encrypted storage for the Proton session.
 *
 * This exists because of a real incident: the spike logged in from scratch on every run, and after
 * a handful of runs — one of them with an empty password from a prompt bug — Proton locked the
 * account with code 2028, "unusual activity targeting your account". Repeated SRP logins from an
 * unknown client look exactly like credential stuffing, because that is what credential stuffing
 * looks like.
 *
 * So: log in once, keep the session, refresh it. The Proton password is never stored — only the
 * tokens, and those are encrypted with a key derived from a local passphrase that the user sets for
 * this tool. Anyone who copies the file off the disk gets nothing without it.
 *
 * Deliberate interim: the key derivation here is scrypt from Node's own crypto, not the Argon2id
 * and passkey-derived key the project plans. That plan needs the encrypted database and WebAuthn
 * that M1 brings; this file is the bridge until then and its format is versioned so the upgrade is
 * a migration rather than a re-login.
 */

const FORMAT_VERSION = 1;

/** Deliberately expensive: this passphrase guards live session tokens. */
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface StoredEnvelope {
    version: number;
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
}

export interface StoredSession {
    session: ProtonSession;
    userId: string;
    /** Unix seconds. Informational — Proton is the authority on whether a token still works. */
    createdAt: number;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
    return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, SCRYPT_PARAMS);
}

export async function saveSession(path: string, stored: StoredSession, passphrase: string): Promise<void> {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = deriveKey(passphrase, salt);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(stored), 'utf8'), cipher.final()]);

    const envelope: StoredEnvelope = {
        version: FORMAT_VERSION,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };

    // 0600: the tokens inside grant full access to the mailbox until they are revoked.
    await writePrivateFile(path, JSON.stringify(envelope));
    log.debug({ path }, 'session stored');
}

/** Returns undefined when there is no stored session; throws when there is one and it will not open. */
export async function loadSession(path: string, passphrase: string): Promise<StoredSession | undefined> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }

    const envelope = JSON.parse(raw) as StoredEnvelope;
    if (envelope.version !== FORMAT_VERSION) {
        throw new AppError('VAULT_KEY_REJECTED', {
            message: `Die gespeicherte Sitzung hat Format ${envelope.version}, erwartet wird ${FORMAT_VERSION}.`,
            hint: 'Die Datei löschen und einmal neu anmelden.',
            context: { path, version: envelope.version },
        });
    }

    const key = deriveKey(passphrase, Buffer.from(envelope.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

    try {
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
            decipher.final(),
        ]);
        return JSON.parse(plaintext.toString('utf8')) as StoredSession;
    } catch (cause) {
        // GCM authentication failed: wrong passphrase, or the file was tampered with. Both mean stop.
        throw new AppError('VAULT_KEY_REJECTED', {
            message: 'Die gespeicherte Sitzung liess sich nicht entschlüsseln.',
            hint:
                'Falsche Passphrase — oder die Datei wurde verändert. Bei Zweifeln die Datei löschen ' +
                'und neu anmelden; das ist sicherer als weiterzumachen.',
            context: { path },
            cause,
        });
    }
}

/** Constant-time comparison, for callers that need to check a passphrase without leaking timing. */
export function passphraseMatches(a: string, b: string): boolean {
    const left = Buffer.from(a.normalize('NFKC'), 'utf8');
    const right = Buffer.from(b.normalize('NFKC'), 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}
