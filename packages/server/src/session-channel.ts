import { getLogger } from '@pms/core/logger';

const log = getLogger('login');

/**
 * The state of our connection to Proton: signing in, signing out, and what it is now.
 *
 * The same shape as `SyncChannel` and `ApplyChannel`, and for the same reason: this file knows that
 * a login was *asked for* and nothing about how one is done. The process that holds the session
 * supplies the runner, so a request can start one and cannot be one.
 *
 * One channel for both directions, because it is one piece of state — *are we connected* — and two
 * channels with two streams answering one question would be the worse shape.
 *
 * These are the third and fourth non-GET routes in a project whose promise was two, and both
 * additions are deliberate. Signing in does not write to Proton's data but is the most consequential
 * thing the tool does; signing out is the one route on the list that only ever *takes away* — and a
 * tool that makes connecting easy and disconnecting hard has the wrong shape.
 *
 * What it does *not* relax: `LoginGuard` still refuses an attempt during a cooldown and refuses
 * indefinitely after a 2028, and nothing here retries. A button in a web interface makes it easy to
 * hammer a login, which is exactly what caused the lockout this guard exists for — so the dashboard
 * shows the guard's state and the reason, rather than offering a button that will be refused.
 */

export type SessionState =
    | { state: 'idle' }
    /** Refused before anything opened — a cooldown, a lockout, or a session that is already good. */
    | { state: 'refused'; reason: string; code: string }
    | { state: 'opening'; startedAt: number }
    /** The window is up and waiting for a person. Nothing here can hurry that along. */
    | { state: 'waiting'; startedAt: number }
    | { state: 'done'; finishedAt: number }
    | { state: 'disconnecting'; startedAt: number }
    /**
     * The connection is cut and the local copy is gone.
     *
     * `revoked` says whether Proton was actually told. It can be false after a successful
     * disconnect — the revoke is the one step that can fail without stopping the rest — and saying
     * „überall abgemeldet" when only this machine forgot would be the single lie this button
     * cannot afford.
     */
    | { state: 'disconnected'; revoked: boolean; revokeError?: string | undefined; finishedAt: number }
    | { state: 'failed'; error: string; code?: string | undefined; finishedAt: number };

export type LoginRunner = (report: (state: 'opening' | 'waiting') => void) => Promise<void>;

/** Ends the connection. `everywhere` also asks Proton to revoke the token. */
export type DisconnectRunner = (everywhere: boolean) => Promise<{
    revoked: boolean;
    revokeError?: string | undefined;
}>;

type Listener = (state: SessionState) => void;

export class SessionChannel {
    #state: SessionState = { state: 'idle' };
    /** Whether this process currently holds a usable Proton session. */
    #signedIn = false;
    readonly #listeners = new Set<Listener>();
    readonly #run: LoginRunner | undefined;
    readonly #disconnect: DisconnectRunner | undefined;

    constructor(run?: LoginRunner, disconnect?: DisconnectRunner, signedIn = false) {
        this.#run = run;
        this.#disconnect = disconnect;
        this.#signedIn = signedIn;
    }

    /** So the interface knows which of the two buttons to offer. */
    get signedIn(): boolean {
        return this.#signedIn;
    }

    get available(): boolean {
        return this.#run !== undefined;
    }

    get state(): SessionState {
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
                this.#signedIn = true;
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

    /**
     * Cut the connection. Returns why it could not start, or undefined when it did.
     *
     * Refused while a login window is open, because the two would fight over the same session file
     * — and because a person with a browser window waiting for them has not decided to disconnect.
     */
    disconnect(everywhere: boolean): string | undefined {
        if (this.#disconnect === undefined) {
            return 'Dieser Server kann die Verbindung nicht trennen.';
        }
        if (this.#state.state === 'opening' || this.#state.state === 'waiting') {
            return 'Es läuft gerade eine Anmeldung. Erst das Browser-Fenster abschliessen oder schliessen.';
        }
        if (this.#state.state === 'disconnecting') {
            return 'Die Verbindung wird bereits getrennt.';
        }

        const run = this.#disconnect;
        this.#emit({ state: 'disconnecting', startedAt: Date.now() });

        void run(everywhere)
            .then((result) => {
                this.#signedIn = false;
                this.#emit({
                    state: 'disconnected',
                    revoked: result.revoked,
                    ...(result.revokeError === undefined ? {} : { revokeError: result.revokeError }),
                    finishedAt: Date.now(),
                });
            })
            .catch((cause: unknown) => {
                const error = cause instanceof Error ? cause.message : 'Unbekannter Fehler.';
                log.warn({}, 'disconnect failed');
                this.#emit({ state: 'failed', error, finishedAt: Date.now() });
            });

        return undefined;
    }

    #emit(state: SessionState): void {
        this.#state = state;
        for (const listener of this.#listeners) {
            listener(state);
        }
    }
}
