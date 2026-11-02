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
/**
 * Told whenever a run begins, and what interval was asked for.
 *
 * The channel has no timer of its own — the process that owns one is `serve-command`, outside this
 * package, and that is where it stays. This is the notification that lets it restart the clock, so
 * a sync at 4:59 is not chased by an automatic one at 5:00 that gets refused and logged at debug.
 */
export type SyncStarted = (options: { intervalMinutes: number | undefined }) => void;

/** Bounds for the auto-sync interval. 0 turns it off; a day is the far end of plausible. */
export const MIN_AUTO_SYNC_MINUTES = 1;
export const MAX_AUTO_SYNC_MINUTES = 1440;

export class SyncChannel {
    #state: SyncState = { state: 'idle' };
    #nextRunAt: number | undefined;
    readonly #listeners = new Set<Listener>();
    readonly #run: SyncRunner | undefined;
    readonly #onStarted: SyncStarted | undefined;

    /** Undefined when this server has no way to reach Proton — the demo and test case. */
    constructor(run?: SyncRunner, onStarted?: SyncStarted) {
        this.#run = run;
        this.#onStarted = onStarted;
    }

    get available(): boolean {
        return this.#run !== undefined;
    }

    get state(): SyncState {
        return this.#state;
    }

    /**
     * When the timer will fire next, in unix seconds, or undefined when there is no timer.
     *
     * Reported rather than computed in the browser. „Letzter Sync plus das Intervall aus den
     * Einstellungen" is the obvious guess and it is wrong twice over: the setting only reaches the
     * server on the next manual sync, and the timer restarts on every run — so the dashboard would
     * confidently name a time nothing was scheduled for.
     *
     * The channel holds it and does not own it. The timer lives in the process that has one.
     */
    get nextRunAt(): number | undefined {
        return this.#nextRunAt;
    }

    set nextRunAt(value: number | undefined) {
        this.#nextRunAt = value;
        // Not an event of its own: it changes when a run starts or the interval does, and both of
        // those already push a state down the stream.
    }

    subscribe(listener: Listener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Returns why it could not start, or undefined when it did.
     *
     * `intervalMinutes` is the dashboard asking for a different auto-sync rhythm. It rides on this
     * call rather than on a route of its own — the promise is that this server has exactly two
     * non-GET routes, and changing a local timer is not worth spending the third on. A rejected
     * value refuses the whole request rather than being quietly clamped: a number the user typed
     * and a number the server chose should never be silently different.
     */
    start(intervalMinutes?: number): string | undefined {
        if (this.#run === undefined) {
            return 'Dieser Server kann nicht synchronisieren — er hat keine Verbindung zu Proton.';
        }
        if (intervalMinutes !== undefined && !isUsableInterval(intervalMinutes)) {
            return `Ein Intervall von ${String(intervalMinutes)} Minuten ergibt keinen Sinn — 0 schaltet ab, sonst ${String(MIN_AUTO_SYNC_MINUTES)} bis ${String(MAX_AUTO_SYNC_MINUTES)}.`;
        }
        if (this.#state.state === 'running') {
            return 'Es läuft bereits eine Synchronisation.';
        }

        // Before the run, so the clock restarts from the moment the work began rather than from
        // whenever it happens to finish.
        this.#onStarted?.({ intervalMinutes });

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

/** 0 means off. Anything else has to be a whole number of minutes inside the bounds above. */
export function isUsableInterval(minutes: number): boolean {
    if (!Number.isInteger(minutes) || minutes < 0) {
        return false;
    }
    return minutes === 0 || (minutes >= MIN_AUTO_SYNC_MINUTES && minutes <= MAX_AUTO_SYNC_MINUTES);
}
