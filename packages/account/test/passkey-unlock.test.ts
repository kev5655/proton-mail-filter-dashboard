import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { kekFromPrf, newPrfSalt, unwrapMasterKey, wrapMasterKey } from '../src/vault-key.js';

/**
 * Unlocking with a passkey and no password.
 *
 * For most of this project's life the answer was "impossible", and the reason was structural rather
 * than a policy: WebAuthn returns a signature, and there is nothing in a signature to unwrap a key
 * with. The **PRF extension** returns 32 bytes instead — deterministic for one credential and one
 * salt, and uncomputable without the authenticator. That is key material, so it can carry a second
 * wrapping of the master key beside the password's.
 *
 * What these tests are about is therefore not "does WebAuthn verify". That is
 * `@simplewebauthn/server`'s job and is stubbed here deliberately: verifying an assertion by hand is
 * the thing `passkey.ts` explains it will not do. What is tested is everything this project decides
 * *around* it — which passkey may open the account, what happens to a wrong PRF output, and whether
 * enabling the capability can be done by somebody who does not already hold the key.
 */

const PASSWORD = 'ein-langes-passwort-das-niemand-raet';

/*
 * Argon2id at 64 MiB costs about a second per derivation and registering pays one. Room rather than
 * a cheaper KDF — the cost is what makes a stolen `data/` useless.
 */
const SLOW = { timeout: 60_000 };

/** What the stubbed WebAuthn verification will report. Set per test. */
let verified: { id: string; counter: number } | Error = { id: 'cred-1', counter: 1 };

vi.mock('../src/passkey.js', () => ({
    finishPasskeyLogin: async (
        _response: unknown,
        _challenge: string,
        _origin: string,
        _passkeys: unknown,
        requireUserVerification?: boolean
    ) => {
        // Recorded so a test can assert it, because this is the one flag that decides whether mere
        // possession of the authenticator is enough.
        seenUserVerification = requireUserVerification === true;
        if (verified instanceof Error) {
            throw verified;
        }
        return verified;
    },
}));

let seenUserVerification = false;
let directory: string;
let path: string;

async function freshVault(): Promise<InstanceType<typeof import('../src/vault.js').Vault>> {
    const { Vault } = await import('../src/vault.js');
    const vault = new Vault(path);
    await vault.load();
    return vault;
}

/** A registered passkey, the way one looks before it can unlock anything. */
const CREDENTIAL = {
    id: 'cred-1',
    publicKey: Buffer.from('nicht-geprueft').toString('base64url'),
    counter: 0,
    transports: ['internal'],
    label: 'Telefon',
    addedAt: 1_700_000_000,
};

const PRF = randomBytes(32).toString('base64');

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-prf-'));
    path = join(directory, 'account.json');
    verified = { id: 'cred-1', counter: 1 };
    seenUserVerification = false;
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe('making a passkey an unlock method', SLOW, () => {
    it('needs the account open, so a passkey cannot enrol itself', async () => {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);
        vault.lock(true);

        // The master key has to be in hand to be wrapped a second time. That is the whole argument:
        // enabling this is something only somebody who already knows the password can do.
        await expect(
            vault.enablePasskeyUnlock({
                response: {},
                challenge: 'c',
                origin: 'http://localhost',
                prfOutput: PRF,
            })
        ).rejects.toThrow(/gesperrt/i);
    });

    it('requires user verification, not merely prefers it', async () => {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);

        await vault.enablePasskeyUnlock({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });

        // Without it, possession of the authenticator would be enough to open a mailbox.
        expect(seenUserVerification).toBe(true);
    });

    it('reports which passkeys can open the account, without unlocking anything', async () => {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);
        await vault.addPasskey({ ...CREDENTIAL, id: 'cred-2', label: 'Stick' });
        await vault.enablePasskeyUnlock({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });
        vault.lock(true);

        // Readable from the account file alone — the lock screen needs it before anything is open.
        const locked = await freshVault();
        expect(locked.state.passkeyUnlock).toBe(true);
        expect(locked.state.passkeys.map((entry) => [entry.id, entry.unlocks])).toEqual([
            ['cred-1', true],
            ['cred-2', false],
        ]);
    });
});

describe('unlocking with it', SLOW, () => {
    async function enabled(): Promise<InstanceType<typeof import('../src/vault.js').Vault>> {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);
        await vault.enablePasskeyUnlock({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });
        vault.lock(true);
        return vault;
    }

    it('opens the account with no password at all', async () => {
        const vault = await enabled();

        await vault.unlockWithPasskey({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });

        expect(vault.state.unlocked).toBe(true);
        // And it is the *same* key: the passphrase everything else speaks still works.
        expect(vault.passphrase()).toHaveLength(64);
    });

    it('refuses a different PRF output', async () => {
        const vault = await enabled();

        // A wrong key fails at the GCM tag, which is where a wrong key belongs — not somewhere far
        // away, as a database that will not open.
        await expect(
            vault.unlockWithPasskey({
                response: {},
                challenge: 'c',
                origin: 'http://localhost',
                prfOutput: randomBytes(32).toString('base64'),
            })
        ).rejects.toThrow(/Passwort falsch/);
        expect(vault.state.unlocked).toBe(false);
    });

    it('refuses a passkey that was never made an unlock method', async () => {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);
        vault.lock(true);

        verified = { id: 'cred-1', counter: 1 };
        await expect(
            vault.unlockWithPasskey({
                response: {},
                challenge: 'c',
                origin: 'http://localhost',
                prfOutput: PRF,
            })
        ).rejects.toThrow(/schliesst nicht auf/);
    });

    it('refuses when the assertion itself does not verify', async () => {
        const vault = await enabled();
        verified = new Error('Der Passkey wurde nicht akzeptiert.');

        await expect(
            vault.unlockWithPasskey({
                response: {},
                challenge: 'c',
                origin: 'http://localhost',
                prfOutput: PRF,
            })
        ).rejects.toThrow(/nicht akzeptiert/);
        expect(vault.state.unlocked).toBe(false);
    });

    it('can be taken back, leaving the passkey as a second factor', async () => {
        const vault = await enabled();
        await vault.unlockWithPasskey({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });

        await vault.disablePasskeyUnlock('cred-1');
        vault.lock(true);

        const after = await freshVault();
        expect(after.state.passkeyUnlock).toBe(false);
        // The password wrapping was never touched, so the account is not lost with it.
        await after.unlock({ password: PASSWORD });
        expect(after.state.unlocked).toBe(true);
    });
});

describe('the key material itself', () => {
    it('is domain-separated, so the same PRF output is not a key for something else', () => {
        const prf = randomBytes(32);
        const salt = Buffer.from(newPrfSalt(), 'base64');

        const kek = kekFromPrf(prf, salt);

        expect(kek).toHaveLength(32);
        // Not the PRF output itself. If it were, any other use of the same authenticator and salt
        // would share a key with this one.
        expect(Buffer.from(kek).equals(prf)).toBe(false);
    });

    it('is stable for the same input and different for a different salt', () => {
        const prf = randomBytes(32);
        const salt = Buffer.from(newPrfSalt(), 'base64');

        expect(Buffer.from(kekFromPrf(prf, salt))).toEqual(Buffer.from(kekFromPrf(prf, salt)));
        expect(Buffer.from(kekFromPrf(prf, Buffer.from(newPrfSalt(), 'base64')))).not.toEqual(
            Buffer.from(kekFromPrf(prf, salt))
        );
    });

    it('refuses output too short to be key material', () => {
        // A browser that returns something truncated must fail loudly rather than produce a key
        // with less entropy than it looks like it has.
        expect(() => kekFromPrf(randomBytes(16), randomBytes(32))).toThrow(/kein Schlüsselmaterial/);
    });

    it('round-trips the master secret', () => {
        const kek = kekFromPrf(randomBytes(32), randomBytes(32));
        const secret = randomBytes(32).toString('hex');

        expect(unwrapMasterKey(wrapMasterKey(secret, kek), kek)).toBe(secret);
    });
});

/** Proof the account file gives nothing away: the wrapping is there, the key is not. */
describe('what lands on disk', SLOW, () => {
    it('stores a wrapping, never the key', async () => {
        const vault = await freshVault();
        await vault.register({ username: 'kevin', password: PASSWORD });
        await vault.addPasskey(CREDENTIAL);
        const secret = vault.passphrase();
        await vault.enablePasskeyUnlock({
            response: {},
            challenge: 'c',
            origin: 'http://localhost',
            prfOutput: PRF,
        });

        const raw = await readFile(path, 'utf8');

        expect(raw).not.toContain(secret);
        expect(raw).not.toContain(PRF);
        expect(JSON.parse(raw).passkeys[0].wrapped).toMatchObject({
            iv: expect.any(String),
            tag: expect.any(String),
            ciphertext: expect.any(String),
        });
    });
});
