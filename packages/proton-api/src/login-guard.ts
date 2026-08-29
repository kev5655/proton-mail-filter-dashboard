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
 *
 * An account lock is treated differently from a rejected attempt: it does not expire on a timer at
 * all. Proton's own remedy for a 2028 is a regular sign-in at mail.proton.me, not waiting — so a
 * clock here would only invite the next blind attempt, which is what extends the lock. The block is
 * lifted by the account owner confirming they got in, and by nothing else.
 *
 * This is a courtesy to Proton's abuse systems and a protection for the user's account. It is not a
 * security control and does not pretend to be one — deleting the file resets it.
 */

/** Escalating waits after consecutive failures, in seconds. The last value repeats. */
const COOLDOWN_SECONDS = [60, 300, 900, 3600] as const;


const LOCKOUT_CODES = new Set(['PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED']);
const PROTON_ACCOUNT_LOCKED = 2028;

export interface LoginAttemptState {
    consecutiveFailures: number;
    /** Unix seconds. */
    lastFailureAt: number;
    /** Unix seconds before which no attempt may be made. */
    retryAfter: number;
    lastReason: string;
    /**
     * Set after an account lock. No amount of waiting clears it — only `clearLockout()`, called
     * when the owner has signed in at mail.proton.me and seen the account is reachable.
     */
    lockedOut?: boolean;
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

        if (state.lockedOut === true) {
            throw new AppError('PROTON_RATE_LIMITED', {
                message: 'Proton hat das Konto gesperrt (Code 2028). Anmeldung ist blockiert.',
                hint:
                    'Warten hilft hier nicht — Proton löst das über einen regulären Login. Bitte ' +
                    'einmal auf mail.proton.me anmelden. Wenn das klappt: `pnpm spike ' +
                    '--sperre-geklaert`, danach ist wieder genau ein Versuch frei.',
                context: {
                    consecutiveFailures: state.consecutiveFailures,
                    lastFailureAt: state.lastFailureAt,
                    lastReason: state.lastReason,
                },
            });
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

    /**
     * Lift an account lock, on the owner's word that Proton let them in again.
     *
     * Deliberately a separate, manual step rather than an expiring timer: the thing that clears a
     * 2028 is a successful regular sign-in, so requiring evidence of one is the honest gate. The
     * escalating cooldown is left in place — one attempt at a time, still.
     */
    async clearLockout(): Promise<LoginAttemptState | undefined> {
        const state = await this.read();
        if (state === undefined || state.lockedOut !== true) {
            return undefined;
        }
        const cleared: LoginAttemptState = {
            consecutiveFailures: 0,
            lastFailureAt: state.lastFailureAt,
            retryAfter: 0,
            lastReason: `${state.lastReason} (vom Nutzer als geklärt markiert)`,
        };
        await this.#write(cleared);
        log.info({ previousReason: state.lastReason }, 'lockout cleared by the account owner');
        return state;
    }

    async recordFailure(error: unknown): Promise<void> {
        const previous = await this.read();
        const failures = (previous?.consecutiveFailures ?? 0) + 1;
        const now = this.#now();
        const lockedOut = isAccountLockout(error);

        const cooldown = COOLDOWN_SECONDS[
            Math.min(failures - 1, COOLDOWN_SECONDS.length - 1)
        ] as number;

        const reason = isAppError(error) ? error.code : 'unbekannter Fehler';
        await this.#write({
            consecutiveFailures: failures,
            lastFailureAt: now,
            retryAfter: now + cooldown,
            lastReason: reason,
            ...(lockedOut ? { lockedOut: true } : {}),
        });
        log.warn({ failures, cooldown, reason, lockedOut }, 'login failed, cooling down');
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
