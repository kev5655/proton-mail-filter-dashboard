import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { argon2id } from '@noble/hashes/argon2.js';
import { AppError } from '@pms/core/errors';
import { writePrivateFile } from '@pms/core/private-file';
import { z } from 'zod';

/**
 * Turning a passphrase into the database key.
 *
 * SQLCipher will happily derive a key from a passphrase itself, using PBKDF2. We do not let it:
 * PBKDF2 is only as expensive as its iteration count, and an attacker with the database file has
 * unlimited attempts on hardware we do not choose. Argon2id costs *memory* as well as time, which
 * is what makes a GPU farm stop being an advantage.
 *
 * So the passphrase becomes 32 raw bytes here, and SQLCipher is handed those bytes rather than the
 * passphrase. Its own KDF never runs.
 *
 * The implementation is `@noble/hashes` — audited, pure JavaScript, no build step. A native Argon2
 * would be faster, but this runs once per start and a second and a half is not worth another
 * package that compiles code on the user's machine.
 */

/**
 * Cost parameters, stored alongside the salt so an existing database keeps opening after they are
 * raised. 64 MiB and three passes is comfortably above OWASP's floor; the cost is paid once.
 */
const PARAMS = { t: 3, m: 65_536, p: 1 } as const;

const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * What sits next to the database file.
 *
 * None of it is secret — a salt is not a secret, and neither is the cost of the function that used
 * it. It lives outside the database because it is needed *before* the database can be opened.
 * Versioned, so a later move to different parameters, or to a key from a passkey, is a migration
 * rather than a locked-out user.
 */
const headerSchema = z.object({
    version: z.literal(1),
    kdf: z.literal('argon2id'),
    salt: z.string(),
    t: z.number().int().positive(),
    m: z.number().int().positive(),
    p: z.number().int().positive(),
});

export type KeyHeader = z.output<typeof headerSchema>;

export function headerPath(databasePath: string): string {
    return `${databasePath}.kdf.json`;
}

/** Read the header beside a database, or create one for a database that does not exist yet. */
export async function loadOrCreateHeader(databasePath: string): Promise<KeyHeader> {
    const path = headerPath(databasePath);
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        const header: KeyHeader = {
            version: 1,
            kdf: 'argon2id',
            salt: randomBytes(SALT_BYTES).toString('base64'),
            ...PARAMS,
        };
        await writePrivateFile(path, JSON.stringify(header, null, 2));
        return header;
    }

    const parsed = headerSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
        throw new AppError('VAULT_KEY_REJECTED', {
            message: 'Die Schlüsseldatei neben der Datenbank ist beschädigt oder von einer neueren Version.',
            hint:
                `Betroffen ist \`${path}\`. Ohne sie lässt sich die Datenbank nicht öffnen — sie ` +
                'enthält kein Geheimnis, aber ohne das Salz darin passt kein Schlüssel mehr.',
            context: { path, issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
        });
    }
    return parsed.data;
}

/**
 * Derive the raw database key.
 *
 * Returns hex because that is the form SQLCipher takes a raw key in. The bytes never touch disk and
 * never reach a log: `SECRET_KEYS` covers the field names this ends up under.
 */
export function deriveKey(passphrase: string, header: KeyHeader): string {
    if (passphrase === '') {
        // An empty passphrase derives a perfectly valid key, which is the problem: the database
        // would open and appear protected. The same mistake once sent an empty password to Proton.
        throw new AppError('VAULT_KEY_REJECTED', {
            message: 'Es wurde keine Passphrase angegeben.',
            hint: 'Die Datenbank wird damit verschlüsselt — ohne sie gibt es keinen Schutz.',
            context: {},
        });
    }

    const key = argon2id(passphrase, Buffer.from(header.salt, 'base64'), {
        t: header.t,
        m: header.m,
        p: header.p,
        dkLen: KEY_BYTES,
    });
    return Buffer.from(key).toString('hex');
}
