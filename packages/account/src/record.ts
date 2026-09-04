import { readFile } from 'node:fs/promises';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { writePrivateFile } from '@pms/core/private-file';
import { z } from 'zod';

const log = getLogger('account');

/**
 * The account file: who may unlock this installation, and how.
 *
 * One account, deliberately. This is a tool somebody runs on their own machine against their own
 * mailbox; a user table would be inventing a multi-tenancy that has nowhere to be multi-tenant.
 *
 * What is in here and what is not is the whole design:
 *
 *  - The **wrapped master key** — the only copy of the key that opens the database and the Proton
 *    session, encrypted with a key derived from the password. Without the password this file is
 *    inert.
 *  - The **TOTP secret, sealed with the master key** rather than stored plainly. Somebody with this
 *    file and no password can therefore not generate valid codes — otherwise the second factor
 *    would be defeated without touching the first.
 *  - **Passkey public keys, in the clear**, because that is what they are. A public key is not a
 *    secret and treating it as one would only obscure what it is.
 *  - **No password**, in any form. Not hashed, not verified against — the wrapping *is* the
 *    verification: a wrong password fails to unwrap, and GCM's tag says so cleanly.
 *
 * Written with `writePrivateFile`, which is owner-only on both platforms, for the same reason the
 * session file is.
 */

const wrappedSchema = z.object({
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
});

const passkeySchema = z.object({
    /** The credential id, base64url, as WebAuthn hands it over. */
    id: z.string(),
    publicKey: z.string(),
    counter: z.number().int().nonnegative(),
    /** What the authenticator said it speaks, so the browser can offer the right prompt. */
    transports: z.array(z.string()).default([]),
    label: z.string(),
    addedAt: z.number().int(),
});

export const accountSchema = z.object({
    version: z.literal(1),
    /** Email or a plain name — this is a label for a login, not an address anything is sent to. */
    username: z.string().min(1),
    createdAt: z.number().int(),
    kdf: z.object({
        salt: z.string(),
        t: z.number().int().positive(),
        m: z.number().int().positive(),
        p: z.number().int().positive(),
    }),
    wrapped: wrappedSchema,
    /** Sealed with the master key, so it needs the password before it can be read. */
    totp: wrappedSchema.optional(),
    passkeys: z.array(passkeySchema).default([]),
    /**
     * How long the unlocked key may stay in memory after the dashboard is locked.
     *
     * Zero means "forget immediately". The default is a compromise somebody asked for: closing the
     * dashboard should not mean typing a password and reconnecting to Proton five minutes later.
     */
    graceMinutes: z.number().int().nonnegative().default(30),
});

export type AccountRecord = z.output<typeof accountSchema>;
export type StoredPasskey = z.output<typeof passkeySchema>;

export async function loadAccount(path: string): Promise<AccountRecord | undefined> {
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // No account yet is the state a first run is in, not a failure.
            return undefined;
        }
        throw error;
    }

    const parsed = accountSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new AppError('ACCOUNT_MISSING', {
            message: 'Die Kontodatei ist unlesbar.',
            hint:
                'Sie beschreibt, wer dieses Werkzeug aufschliessen darf. Repariert wird sie nicht ' +
                'automatisch — das würde die Sperre umgehen, die sie darstellt.',
            context: { path, problem: parsed.error.issues[0]?.message },
        });
    }
    return parsed.data;
}

export async function saveAccount(path: string, record: AccountRecord): Promise<void> {
    await writePrivateFile(path, `${JSON.stringify(record, null, 2)}\n`);
    log.info({ passkeys: record.passkeys.length, totp: record.totp !== undefined }, 'account saved');
}
