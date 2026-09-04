import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newTotpSecret, totpCode } from '../src/totp.js';
import { Vault } from '../src/vault.js';

/**
 * The gate in front of the local data — and the reason it is a gate rather than a screen.
 *
 * Everything on this machine is encrypted with a master key that only the password unwraps, so the
 * question these tests answer is not "does the form reject a wrong password". It is: **is the data
 * actually unreachable without it**, and does the account file give anything away on its own.
 */

const PASSWORD = 'ein-langes-passwort-das-niemand-raet';

/*
 * Argon2id at 64 MiB and three passes costs about a second per derivation, and several of these
 * tests derive three or four times. The cost is the feature — it is what makes a stolen `data/`
 * directory useless — so the answer is room, not a cheaper KDF. A test that times out at random
 * gets ignored, which is worse than one that takes a while.
 */
const SLOW = { timeout: 60_000 };

let directory: string;
let path: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-vault-'));
    path = join(directory, 'account.json');
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

async function registered(now = () => 1_700_000_000_000): Promise<Vault> {
    const vault = new Vault(path, now);
    await vault.load();
    await vault.register({ username: 'kevin@example.com', password: PASSWORD });
    return vault;
}

describe('before there is an account', SLOW, () => {
    it('says so rather than failing, because a first run is not an error', async () => {
        const vault = new Vault(path);
        await vault.load();

        expect(vault.state.registered).toBe(false);
        expect(vault.state.unlocked).toBe(false);
    });

    it('refuses to hand out a passphrase', async () => {
        const vault = new Vault(path);
        await vault.load();

        expect(() => vault.passphrase()).toThrow(/gesperrt/);
    });
});

describe('the account file on its own', SLOW, () => {
    it('contains no password, in any form', async () => {
        // Not hashed either. The wrapping *is* the verification — a wrong password fails to unwrap,
        // and there is no second check to drift out of step with it.
        await registered();
        const raw = await readFile(path, 'utf8');

        expect(raw).not.toContain(PASSWORD);
        expect(JSON.parse(raw)).not.toHaveProperty('passwordHash');
        expect(JSON.parse(raw)).not.toHaveProperty('verifier');
    });

    it('is inert without the password', async () => {
        await registered();

        const other = new Vault(path);
        await other.load();

        expect(other.state.registered).toBe(true);
        expect(other.state.unlocked).toBe(false);
        await expect(other.unlock({ password: 'falsch' })).rejects.toMatchObject({
            code: 'ACCOUNT_PASSWORD_WRONG',
        });
    });

    it('keeps the TOTP secret out of reach of whoever holds the file', async () => {
        // Sealed with the master key, so somebody with the account file and no password cannot
        // generate valid codes — otherwise the second factor is defeated without touching the first.
        const vault = await registered();
        const secret = newTotpSecret();
        await vault.enableTotp(secret);

        expect(await readFile(path, 'utf8')).not.toContain(secret);
    });
});

describe('unlocking', SLOW, () => {
    it('hands out the same passphrase every time, or nothing would open twice', async () => {
        const vault = await registered();
        const first = vault.passphrase();

        const again = new Vault(path);
        await again.load();
        await again.unlock({ password: PASSWORD });

        expect(again.passphrase()).toBe(first);
    });

    it('demands the second factor when one is configured, and says which', async () => {
        const vault = await registered();
        await vault.enableTotp(newTotpSecret());
        vault.lock(true);

        await expect(vault.unlock({ password: PASSWORD })).rejects.toMatchObject({
            code: 'ACCOUNT_SECOND_FACTOR_REQUIRED',
        });
    });

    it('checks the password before the code, so a wrong password says so', async () => {
        // Order matters for what the failure reveals: with the code checked first, a wrong password
        // and a wrong code would be indistinguishable, and the message would have to be vaguer than
        // it needs to be.
        const vault = await registered();
        await vault.enableTotp(newTotpSecret());
        vault.lock(true);

        await expect(vault.unlock({ password: 'falsch', totp: '000000' })).rejects.toMatchObject({
            code: 'ACCOUNT_PASSWORD_WRONG',
        });
    });

    it('accepts a real code', async () => {
        const at = 1_700_000_000;
        const vault = new Vault(path, () => at * 1000);
        await vault.load();
        await vault.register({ username: 'kevin', password: PASSWORD });

        const secret = newTotpSecret();
        await vault.enableTotp(secret);
        vault.lock(true);

        await vault.unlock({ password: PASSWORD, totp: totpCode(secret, at) });
        expect(vault.state.unlocked).toBe(true);
    });
});

describe('locking, and the grace period', SLOW, () => {
    it('keeps the key for the grace period, so closing a tab is not a re-login', async () => {
        const vault = await registered();

        vault.lock();

        // Deliberately weaker than „locked" sounds, bounded, configurable, and stated in the
        // interface — a grace period nobody is told about would be a lie about how locked it is.
        expect(vault.withinGrace).toBe(true);
        expect(vault.state.unlocked).toBe(true);
        expect(vault.state.graceUntil).toBeGreaterThan(0);
    });

    it('drops it at once when asked, whatever the grace is', async () => {
        const vault = await registered();

        vault.lock(true);

        expect(vault.state.unlocked).toBe(false);
        expect(() => vault.passphrase()).toThrow(/gesperrt/);
    });

    it('drops it at once when the grace is zero', async () => {
        const vault = await registered();
        await vault.setGraceMinutes(0);

        vault.lock();

        expect(vault.state.unlocked).toBe(false);
    });
});

describe('changing the password', SLOW, () => {
    it('keeps the key, so nothing has to be re-encrypted', async () => {
        // A password change that rewrote a database of somebody's mail would have a dozen ways to be
        // interrupted halfway. This has none: only the wrapping is redone.
        const vault = await registered();
        const before = vault.passphrase();

        await vault.changePassword(PASSWORD, 'ein-anderes-langes-passwort');

        expect(vault.passphrase()).toBe(before);
    });

    it('refuses when the current password is wrong', async () => {
        const vault = await registered();

        await expect(vault.changePassword('falsch', 'neu-und-lang-genug')).rejects.toMatchObject({
            code: 'ACCOUNT_PASSWORD_WRONG',
        });
    });

    it('means the old password no longer opens it', async () => {
        const vault = await registered();
        await vault.changePassword(PASSWORD, 'ein-anderes-langes-passwort');

        const again = new Vault(path);
        await again.load();

        await expect(again.unlock({ password: PASSWORD })).rejects.toMatchObject({
            code: 'ACCOUNT_PASSWORD_WRONG',
        });
        await again.unlock({ password: 'ein-anderes-langes-passwort' });
        expect(again.state.unlocked).toBe(true);
    });
});

describe('registering', SLOW, () => {
    it('refuses a second account rather than orphaning the first key', async () => {
        // Overwriting would generate a new master key and make every byte the old one encrypted
        // unreadable — a database and a Proton session lost to a form submitted twice.
        const vault = await registered();

        await expect(vault.register({ username: 'wer', password: 'anderes-passwort' })).rejects.toMatchObject(
            { code: 'ACCOUNT_EXISTS' }
        );
    });

    it('refuses an empty password', async () => {
        const vault = new Vault(path);
        await vault.load();

        await expect(vault.register({ username: 'kevin', password: '' })).rejects.toMatchObject({
            code: 'ACCOUNT_PASSWORD_EMPTY',
        });
    });

    it('leaves the tool unlocked, because registering is a login', async () => {
        const vault = await registered();
        expect(vault.state.unlocked).toBe(true);
    });
});
