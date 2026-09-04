import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

import { finishPasskeyLogin } from './passkey.js';
import { loadAccount, saveAccount, type AccountRecord, type StoredPasskey } from './record.js';
import { verifyTotp } from './totp.js';
import {
    deriveKek,
    newKdfParams,
    newMasterSecret,
    openWithMasterKey,
    sealWithMasterKey,
    unwrapMasterKey,
    wrapMasterKey,
} from './vault-key.js';

const log = getLogger('account');

/**
 * The gate in front of the local data, and the thing that holds the key while it is open.
 *
 * Everything on this machine — the mailbox database and the stored Proton session — is encrypted
 * with a master key that only the password can unwrap. So this is not a login that guards a screen;
 * it is the reason the data is unreadable without it. Somebody who copies `data/` and has no
 * password has a directory of noise.
 *
 * **The grace period is the part worth understanding.** Locking the dashboard does not throw the
 * key away immediately: it is kept for a while, so closing a tab does not mean typing a password
 * and reconnecting to Proton a minute later. That is a deliberate weakening of the guarantee for a
 * real convenience, it is bounded, it is configurable down to zero, and the interface says how long
 * it lasts. A grace period nobody is told about would be a lie about how locked "locked" is.
 *
 * The key lives in a private field of one object in one process. It is never written anywhere, and
 * ending the process ends it.
 */

export interface VaultState {
    /** Whether an account exists at all. False means this installation has never been set up. */
    registered: boolean;
    unlocked: boolean;
    username: string | undefined;
    /** What a login will additionally ask for. */
    requiresTotp: boolean;
    passkeys: Array<{ id: string; label: string; addedAt: number }>;
    /** Unix seconds at which the held key is dropped, when it is being held past a lock. */
    graceUntil: number | undefined;
    graceMinutes: number;
}

export interface UnlockInput {
    password: string;
    totp?: string | undefined;
    /** A completed WebAuthn assertion, when one was used. */
    passkey?: { response: unknown; challenge: string; origin: string } | undefined;
}

export class Vault {
    readonly #path: string;
    #record: AccountRecord | undefined;
    #masterSecret: string | undefined;
    #graceUntil: number | undefined;
    #graceTimer: ReturnType<typeof setTimeout> | undefined;
    readonly #now: () => number;

    constructor(path: string, now: () => number = Date.now) {
        this.#path = path;
        this.#now = now;
    }

    /** Read the account file. Called once at startup; absent is a first run, not a failure. */
    async load(): Promise<void> {
        this.#record = await loadAccount(this.#path);
    }

    get state(): VaultState {
        return {
            registered: this.#record !== undefined,
            unlocked: this.#masterSecret !== undefined,
            username: this.#record?.username,
            requiresTotp: this.#record?.totp !== undefined,
            passkeys: (this.#record?.passkeys ?? []).map((passkey) => ({
                id: passkey.id,
                label: passkey.label,
                addedAt: passkey.addedAt,
            })),
            graceUntil: this.#graceUntil,
            graceMinutes: this.#record?.graceMinutes ?? 30,
        };
    }

    /**
     * The passphrase everything else already speaks, or a refusal.
     *
     * Callers ask for this rather than for the key, so nothing outside this file ever holds raw key
     * bytes — and so "locked" is enforced at the one place it can be.
     */
    passphrase(): string {
        if (this.#masterSecret === undefined) {
            throw new AppError('ACCOUNT_LOCKED', {
                message: 'Dieses Werkzeug ist gesperrt.',
                hint: 'Im Dashboard anmelden. Ohne Passwort sind die lokalen Daten nicht lesbar.',
            });
        }
        return this.#masterSecret;
    }

    /**
     * Create the account. Only ever once.
     *
     * Refused when one exists rather than overwriting: overwriting would generate a new master key
     * and orphan every byte the old one encrypted — a database and a Proton session lost to a form
     * somebody submitted twice.
     */
    async register(input: {
        username: string;
        password: string;
        /**
         * An existing passphrase to take over instead of minting a new secret.
         *
         * This is how an installation that already has data keeps it. The database and the stored
         * Proton session were encrypted with whatever came from 1Password or a prompt; generating a
         * fresh key at registration would leave both encrypted with something nobody holds any
         * more — a mailbox lost to a form.
         */
        adoptPassphrase?: string | undefined;
    }): Promise<void> {
        if (this.#record !== undefined) {
            throw new AppError('ACCOUNT_EXISTS', {
                message: 'Für diese Installation gibt es bereits ein Konto.',
                hint:
                    'Ein zweites anzulegen würde einen neuen Schlüssel erzeugen und alles unlesbar ' +
                    'machen, was mit dem alten verschlüsselt ist.',
            });
        }
        if (input.username.trim() === '') {
            throw new AppError('ACCOUNT_MISSING', {
                message: 'Das Konto braucht einen Namen.',
                hint: 'E-Mail oder Benutzername — es ist eine Bezeichnung, keine Adresse.',
            });
        }

        const kdf = newKdfParams();
        const secret =
            input.adoptPassphrase === undefined || input.adoptPassphrase === ''
                ? newMasterSecret()
                : input.adoptPassphrase;
        const record: AccountRecord = {
            version: 1,
            username: input.username.trim(),
            createdAt: Math.floor(this.#now() / 1000),
            kdf,
            wrapped: wrapMasterKey(secret, deriveKek(input.password, kdf)),
            passkeys: [],
            graceMinutes: 30,
        };

        await saveAccount(this.#path, record);
        this.#record = record;
        this.#hold(secret);
        log.info({ username: record.username }, 'account created');
    }

    /**
     * Unlock, in the order that makes the second factor mean something.
     *
     * The password comes first, because it is what actually opens the key. Only then is the TOTP
     * secret readable at all — it is sealed with the master key precisely so that somebody holding
     * the account file cannot generate valid codes. A second factor stored in the clear would be
     * defeated without ever touching the first.
     */
    async unlock(input: UnlockInput): Promise<void> {
        const record = this.#requireRecord();

        // Throws `ACCOUNT_PASSWORD_WRONG` when the wrapping does not authenticate. There is no
        // separate password check to get out of step with this one.
        const secret = unwrapMasterKey(record.wrapped, deriveKek(input.password, record.kdf));

        if (record.totp !== undefined) {
            const totpSecret = openWithMasterKey(record.totp, secret);
            if (input.totp === undefined || input.totp === '') {
                throw new AppError('ACCOUNT_SECOND_FACTOR_REQUIRED', {
                    message: 'Für dieses Konto ist ein Code aus der Authenticator-App nötig.',
                    hint: 'Es wurde nichts aufgeschlossen.',
                });
            }
            if (!verifyTotp(totpSecret, input.totp, Math.floor(this.#now() / 1000))) {
                throw new AppError('ACCOUNT_SECOND_FACTOR_WRONG', {
                    message: 'Der Code stimmt nicht.',
                    hint: 'Er gilt dreissig Sekunden. Stimmt die Uhr des Geräts?',
                });
            }
        }

        if (input.passkey !== undefined) {
            const result = await finishPasskeyLogin(
                input.passkey.response,
                input.passkey.challenge,
                input.passkey.origin,
                record.passkeys
            );
            // The counter is the only state a passkey login leaves behind, and it is what makes a
            // cloned credential detectable. Not writing it back turns that check off silently.
            await this.#update({
                passkeys: record.passkeys.map((passkey) =>
                    passkey.id === result.id ? { ...passkey, counter: result.counter } : passkey
                ),
            });
        }

        this.#hold(secret);
        log.info({ username: record.username }, 'unlocked');
    }

    /**
     * Lock the dashboard, keeping the key for the grace period.
     *
     * `immediate` is the answer to "I am leaving this machine": it drops the key now, whatever the
     * grace is set to. Both are offered because they are different intentions, and guessing which
     * one somebody meant would be wrong half the time.
     */
    lock(immediate = false): void {
        const grace = this.#record?.graceMinutes ?? 0;
        this.#clearTimer();

        if (immediate || grace <= 0 || this.#masterSecret === undefined) {
            this.#masterSecret = undefined;
            this.#graceUntil = undefined;
            log.info({ immediate }, 'locked');
            return;
        }

        this.#graceUntil = Math.floor(this.#now() / 1000) + grace * 60;
        this.#graceTimer = setTimeout(
            () => {
                this.#masterSecret = undefined;
                this.#graceUntil = undefined;
                log.info('grace period elapsed, key dropped');
            },
            grace * 60_000
        );
        // Not a reason to keep the process alive: if nothing else is running, there is nothing to
        // protect either.
        this.#graceTimer.unref?.();
        log.info({ graceMinutes: grace }, 'locked, key held for the grace period');
    }

    /** True while the key is still held after a lock — a re-login then needs no password. */
    get withinGrace(): boolean {
        return this.#graceUntil !== undefined && this.#masterSecret !== undefined;
    }

    /**
     * Whether this is the password, without changing anything.
     *
     * Used where a second confirmation has to be a *secret* rather than a gesture — deleting a
     * folder, for one. It goes through the same unwrapping as an unlock, so there is no separate
     * password check that could drift out of step with the real one, and a wrong password fails
     * here exactly as it fails there.
     *
     * It costs a full Argon2id derivation, which is the point: the same slowness that makes a
     * stolen file useless makes this unpleasant to guess at.
     */
    verifyPassword(password: string): void {
        const record = this.#requireRecord();
        unwrapMasterKey(record.wrapped, deriveKek(password, record.kdf));
    }

    /** Change the password: the master key stays, only its wrapping is redone. */
    async changePassword(current: string, next: string): Promise<void> {
        const record = this.#requireRecord();
        const secret = unwrapMasterKey(record.wrapped, deriveKek(current, record.kdf));
        const kdf = newKdfParams();

        // Nothing is re-encrypted. A password change that rewrote a database of somebody's mail
        // would have a dozen ways to be interrupted halfway, and this has none.
        await this.#update({ kdf, wrapped: wrapMasterKey(secret, deriveKek(next, kdf)) });
        this.#hold(secret);
        log.info('password changed');
    }

    /** Turn on TOTP. The secret is sealed with the master key, so it needs the password to read. */
    async enableTotp(totpSecret: string): Promise<void> {
        await this.#update({ totp: sealWithMasterKey(totpSecret, this.#requireKey()) });
    }

    async disableTotp(): Promise<void> {
        this.#requireKey();
        const record = this.#requireRecord();
        const { totp: _dropped, ...rest } = record;
        await saveAccount(this.#path, { ...rest, passkeys: record.passkeys });
        this.#record = { ...rest, passkeys: record.passkeys } as AccountRecord;
    }

    async addPasskey(passkey: StoredPasskey): Promise<void> {
        this.#requireKey();
        const record = this.#requireRecord();
        await this.#update({ passkeys: [...record.passkeys, passkey] });
    }

    async removePasskey(id: string): Promise<void> {
        this.#requireKey();
        const record = this.#requireRecord();
        await this.#update({ passkeys: record.passkeys.filter((passkey) => passkey.id !== id) });
    }

    async setGraceMinutes(minutes: number): Promise<void> {
        this.#requireKey();
        await this.#update({ graceMinutes: Math.max(0, Math.min(24 * 60, Math.trunc(minutes))) });
    }

    /** The registered keys, for a login that needs to offer them. */
    get passkeys(): readonly StoredPasskey[] {
        return this.#record?.passkeys ?? [];
    }

    #hold(secret: string): void {
        this.#clearTimer();
        this.#masterSecret = secret;
        this.#graceUntil = undefined;
    }

    #clearTimer(): void {
        if (this.#graceTimer !== undefined) {
            clearTimeout(this.#graceTimer);
            this.#graceTimer = undefined;
        }
    }

    #requireRecord(): AccountRecord {
        if (this.#record === undefined) {
            throw new AppError('ACCOUNT_MISSING', {
                message: 'Für diese Installation gibt es noch kein Konto.',
                hint: 'Im Dashboard eines anlegen — damit wird auch der Schlüssel für die lokalen Daten erzeugt.',
            });
        }
        return this.#record;
    }

    #requireKey(): string {
        if (this.#masterSecret === undefined) {
            throw new AppError('ACCOUNT_LOCKED', {
                message: 'Dieses Werkzeug ist gesperrt.',
                hint: 'Erst anmelden — eine Einstellung am Konto zu ändern braucht den Schlüssel.',
            });
        }
        return this.#masterSecret;
    }

    async #update(changes: Partial<AccountRecord>): Promise<void> {
        const next = { ...this.#requireRecord(), ...changes };
        await saveAccount(this.#path, next);
        this.#record = next;
    }
}
