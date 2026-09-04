import { getLogger } from '@pms/core/logger';

const log = getLogger('server');

/**
 * The seam between "the dashboard asked for a sync" and "something talks to Proton".
 *
 * Deliberately an interface with no idea what a sync is. The process that serves HTTP now also
 * holds a read-only Proton session — the owner accepted that, so the button can exist — but the
 * *routing* code must still be unable to reach it. Everything on this side of the seam handles a
 * request; the runner is handed in from outside, and `write-isolation.test.ts` checks that the
 * files which parse HTTP never import the ones that perform it.
 *
 * A sync reads at Proton and writes only to the local mirror. It therefore needs no confirmation —
 * unlike anything that changes the account, which goes a different way entirely.
 */

export interface SyncProgressEvent {
    stage: 'labels' | 'filters' | 'messages';
    done: number;
    total?: number | undefined;
}

export interface SyncSummary {
    labels: number;
    filters: number;
    messages: number;
    /** True when the run stopped at its limit, so the copy is knowingly incomplete. */
    truncated: boolean;
}

/** What the server needs of a sync, and nothing more. */
export type SyncRunner = (report: (progress: SyncProgressEvent) => void) => Promise<SyncSummary>;

export type SyncState =
    | { state: 'idle'; lastError?: string | undefined }
    | { state: 'running'; progress: SyncProgressEvent | undefined; startedAt: number }
    | { state: 'done'; summary: SyncSummary; finishedAt: number }
    | { state: 'failed'; error: string; code?: string | undefined; finishedAt: number };

type Listener = (state: SyncState) => void;

/**
 * One sync at a time, and a place to watch it from.
 *
 * Serialised on purpose. Two concurrent syncs would double the request rate against Proton — the
 * pacing in `ProtonHttp` is per-client, not global — and the second would be writing into the same
 * tables as the first. A second request while one runs is answered, not queued: the caller is told
 * a sync is already going and can watch that one.
 */
export class SyncChannel {
    #state: SyncState = { state: 'idle' };
    readonly #listeners = new Set<Listener>();
    readonly #run: SyncRunner | undefined;

    /** Undefined when this server has no way to reach Proton — the demo and test case. */
    constructor(run?: SyncRunner) {
        this.#run = run;
    }

    get available(): boolean {
        return this.#run !== undefined;
    }

    get state(): SyncState {
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
            return 'Dieser Server kann nicht synchronisieren — er hat keine Verbindung zu Proton.';
        }
        if (this.#state.state === 'running') {
            return 'Es läuft bereits eine Synchronisation.';
        }

        const run = this.#run;
        this.#emit({ state: 'running', progress: undefined, startedAt: Date.now() });

        void run((progress) => {
            if (this.#state.state === 'running') {
                this.#emit({ ...this.#state, progress });
            }
        })
            .then((summary) => {
                this.#emit({ state: 'done', summary, finishedAt: Date.now() });
            })
            .catch((cause: unknown) => {
                const error = cause instanceof Error ? cause.message : 'Unbekannter Fehler.';
                const code =
                    cause !== null && typeof cause === 'object' && 'code' in cause
                        ? String((cause as { code: unknown }).code)
                        : undefined;
                log.warn({ code }, 'sync failed');
                this.#emit({ state: 'failed', error, code, finishedAt: Date.now() });
            });

        return undefined;
    }

    #emit(state: SyncState): void {
        this.#state = state;
        for (const listener of this.#listeners) {
            listener(state);
        }
    }
}
