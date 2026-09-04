import { getLogger } from '@pms/core/logger';

const log = getLogger('login');

/**
 * Signing in, offered over HTTP and performed somewhere HTTP cannot reach.
 *
 * The same shape as `SyncChannel` and `ApplyChannel`, and for the same reason: this file knows that
 * a login was *asked for* and nothing about how one is done. The process that holds the session
 * supplies the runner, so a request can start one and cannot be one.
 *
 * This is the third non-GET route in a project whose promise was two, and the addition is
 * deliberate rather than incidental. It does not write to Proton's data — but it is the most
 * consequential thing the tool does, so it gets its own named route, its own channel, and its own
 * paragraph in CLAUDE.md instead of being folded into something that already existed.
 *
 * What it does *not* relax: `LoginGuard` still refuses an attempt during a cooldown and refuses
 * indefinitely after a 2028, and nothing here retries. A button in a web interface makes it easy to
 * hammer a login, which is exactly what caused the lockout this guard exists for — so the dashboard
 * shows the guard's state and the reason, rather than offering a button that will be refused.
 */

export type LoginState =
    | { state: 'idle' }
    /** Refused before anything opened — a cooldown, a lockout, or a session that is already good. */
    | { state: 'refused'; reason: string; code: string }
    | { state: 'opening'; startedAt: number }
    /** The window is up and waiting for a person. Nothing here can hurry that along. */
    | { state: 'waiting'; startedAt: number }
    | { state: 'done'; finishedAt: number }
    | { state: 'failed'; error: string; code?: string | undefined; finishedAt: number };

export type LoginRunner = (report: (state: 'opening' | 'waiting') => void) => Promise<void>;

type Listener = (state: LoginState) => void;

export class LoginChannel {
    #state: LoginState = { state: 'idle' };
    readonly #listeners = new Set<Listener>();
    readonly #run: LoginRunner | undefined;

    constructor(run?: LoginRunner) {
        this.#run = run;
    }

    get available(): boolean {
        return this.#run !== undefined;
    }

    get state(): LoginState {
        return this.#state;
    }

    subscribe(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Returns why it could not start, or undefined when it did. */
    start(): string | undefined {
        if (this.#run === undefined) {
            return 'Dieser Server kann sich nicht anmelden.';
        }
        if (this.#state.state === 'opening' || this.#state.state === 'waiting') {
            // One window at a time. Two would race for the same session file, and the second would
            // also be a second login attempt — which is the thing the guard exists to ration.
            return 'Es läuft bereits eine Anmeldung. Das Browser-Fenster wartet.';
        }

        const run = this.#run;
        this.#emit({ state: 'opening', startedAt: Date.now() });

        void run((phase) => {
            this.#emit(phase === 'opening' ? { state: 'opening', startedAt: Date.now() } : { state: 'waiting', startedAt: Date.now() });
        })
            .then(() => {
                this.#emit({ state: 'done', finishedAt: Date.now() });
            })
            .catch((cause: unknown) => {
                const error = cause instanceof Error ? cause.message : 'Unbekannter Fehler.';
                const code =
                    cause !== null && typeof cause === 'object' && 'code' in cause
                        ? String((cause as { code: unknown }).code)
                        : undefined;
                // The code, not the message: a login failure's message can name an account.
                log.warn({ code }, 'login failed');
                this.#emit({ state: 'failed', error, code, finishedAt: Date.now() });
            });

        return undefined;
    }

    #emit(state: LoginState): void {
        this.#state = state;
        for (const listener of this.#listeners) {
            listener(state);
        }
    }
}
