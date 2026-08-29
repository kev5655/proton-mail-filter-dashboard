import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AppError, isAppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

const log = getLogger('login-guard');

/**
 * A brake on repeated login attempts.
 *
 * Proton locked this project's test account with code 2028 — "unusual activity targeting your
 * account" — after a short run of failed logins. That was not Proton being twitchy: a program that
 * re-authenticates on every start, sometimes with a bad password, is indistinguishable from an
 * attack. The account owner pays for that with a temporary lockout.
 *
 * So failed logins are recorded on disk and the next attempt is refused until a cooldown passes.
 * The cooldown is deliberately long, and after a 2028 it is much longer, because retrying into an
 * active lock is what extends the lock.
 *
 * This is a courtesy to Proton's abuse systems and a protection for the user's account. It is not a
 * security control and does not pretend to be one — deleting the file resets it.
 */

/** Escalating waits after consecutive failures, in seconds. The last value repeats. */
const COOLDOWN_SECONDS = [60, 300, 900, 3600] as const;

/** After an account lock, back off hard: retrying is what keeps it locked. */
const LOCKOUT_COOLDOWN_SECONDS = 6 * 60 * 60;

const LOCKOUT_CODES = new Set(['PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED']);
const PROTON_ACCOUNT_LOCKED = 2028;

export interface LoginAttemptState {
    consecutiveFailures: number;
    /** Unix seconds. */
    lastFailureAt: number;
    /** Unix seconds before which no attempt may be made. */
    retryAfter: number;
    lastReason: string;
}

export interface LoginGuardOptions {
    path: string;
    /** Injected in tests. */
    now?: () => number;
}

export class LoginGuard {
    readonly #path: string;
    readonly #now: () => number;

    constructor(options: LoginGuardOptions) {
        this.#path = options.path;
        this.#now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
    }

    async read(): Promise<LoginAttemptState | undefined> {
        try {
            return JSON.parse(await readFile(this.#path, 'utf8')) as LoginAttemptState;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined;
            }
            throw error;
        }
    }

    /** Throws if a login must not be attempted yet. Call before every login. */
    async assertMayAttempt(): Promise<void> {
        const state = await this.read();
        if (state === undefined) {
            return;
        }

        const waitSeconds = state.retryAfter - this.#now();
        if (waitSeconds <= 0) {
            return;
        }

        throw new AppError('PROTON_RATE_LIMITED', {
            message: `Anmeldung gesperrt für noch ${formatDuration(waitSeconds)}.`,
            hint:
                `Letzter Fehlschlag: ${state.lastReason}. Weitere Versuche machen es schlimmer — ` +
                'Proton wertet sie als Angriff und verlängert die Sperre. Bitte in der Zwischenzeit ' +
                'einmal regulär über mail.proton.me anmelden.',
            context: {
                consecutiveFailures: state.consecutiveFailures,
                retryAfter: state.retryAfter,
                waitSeconds,
            },
        });
    }

    async recordSuccess(): Promise<void> {
        await this.#write({
            consecutiveFailures: 0,
            lastFailureAt: 0,
            retryAfter: 0,
            lastReason: 'erfolgreich',
        });
    }

    async recordFailure(error: unknown): Promise<void> {
        const previous = await this.read();
        const failures = (previous?.consecutiveFailures ?? 0) + 1;
        const now = this.#now();

        const cooldown = isAccountLockout(error)
            ? LOCKOUT_COOLDOWN_SECONDS
            : (COOLDOWN_SECONDS[Math.min(failures - 1, COOLDOWN_SECONDS.length - 1)] as number);

        const reason = isAppError(error) ? error.code : 'unbekannter Fehler';
        await this.#write({
            consecutiveFailures: failures,
            lastFailureAt: now,
            retryAfter: now + cooldown,
            lastReason: reason,
        });
        log.warn({ failures, cooldown, reason }, 'login failed, cooling down');
    }

    async #write(state: LoginAttemptState): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true });
        await writeFile(this.#path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    }
}

/** Did Proton actually lock the account, as opposed to rejecting one attempt? */
export function isAccountLockout(error: unknown): boolean {
    if (!isAppError(error)) {
        return false;
    }
    if (LOCKOUT_CODES.has(error.code)) {
        return true;
    }
    return error.context['protonCode'] === PROTON_ACCOUNT_LOCKED;
}

export function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds} Sekunden`;
    }
    if (seconds < 3600) {
        return `${Math.ceil(seconds / 60)} Minuten`;
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.ceil((seconds % 3600) / 60);
    return minutes === 0 ? `${hours} Stunden` : `${hours} Stunden ${minutes} Minuten`;
}
