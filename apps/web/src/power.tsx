import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Whether this dashboard has a machine behind it that can be stopped and started.
 *
 * The server that serves this page can offer to stop itself, but nothing inside a stopped process
 * can start it again. So the starting lives outside it — a small program on the host, published
 * under the same name at `/starter` — and this is the browser's side of that.
 *
 * **It asks rather than remembers.** The obvious design was a flag in local storage, set the first
 * time a real server answered, so the page could tell "my machine is off" from "there was never a
 * machine here" — the second being somebody with no server at all, who must not be offered a button that
 * starts something which does not exist. Asking the starter answers the same question better: it is
 * the machine's own answer rather than this browser's memory of it, it survives cleared site data,
 * and it distinguishes a stopped container from a host that is not there at all, which a
 * remembered flag cannot.
 *
 * The probe has to be careful about what counts as an answer. In development vite serves the
 * application shell for any path it does not know, so a request to `/starter/status` can come back
 * `200` with HTML — which is not a starter saying anything. Only a JSON body with a boolean
 * `running` counts.
 */

export type PowerState = 'unknown' | 'absent' | 'running' | 'stopped';

interface PowerContext {
    state: PowerState;
    /** False until the first probe has resolved, so nothing renders a wake screen on a guess. */
    known: boolean;
    /** True while a start or stop is in flight, or while a check is deliberately visible. */
    busy: boolean;
    error?: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    recheck: () => void;
}

const STATUS = '/starter/status';
const START = '/starter/start';
const STOP = '/starter/stop';

/**
 * How long a probe may take before it counts as "nothing there".
 *
 * Short: the starter is on the same machine as whatever is serving this page, and a host that
 * cannot answer in three seconds is one this page cannot usefully offer to control.
 */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * The smallest time a hand-triggered check may take to disappear.
 *
 * Only for checks a person asked for. Without it, pressing "erneut versuchen" against a machine
 * that answers in twenty milliseconds looks like a button that does nothing.
 */
const MINIMUM_VISIBLE_MS = 450;

const Context = createContext<PowerContext | undefined>(undefined);

async function probe(): Promise<PowerState> {
    try {
        const response = await fetch(STATUS, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
            return 'absent';
        }
        const body = (await response.json()) as { running?: unknown };
        // Anything that is not a starter — vite's shell, a static 404 page, a proxy's error — fails
        // here rather than being read as "not running", which would offer a start that goes nowhere.
        if (typeof body.running !== 'boolean') {
            return 'absent';
        }
        return body.running ? 'running' : 'stopped';
    } catch {
        return 'absent';
    }
}

export function PowerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [state, setState] = useState<PowerState>('unknown');
    const [known, setKnown] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const visible = attempt > 0 ? MINIMUM_VISIBLE_MS : 0;
        const started = Date.now();

        if (attempt > 0) {
            setBusy(true);
        }

        void (async () => {
            const next = await probe();
            const remaining = visible - (Date.now() - started);
            if (remaining > 0) {
                await new Promise((resolve) => setTimeout(resolve, remaining));
            }
            if (cancelled) {
                return;
            }
            setState(next);
            setKnown(true);
            setBusy(false);
        })();

        return () => {
            cancelled = true;
        };
    }, [attempt]);

    const recheck = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);

    const act = useCallback(async (endpoint: string, next: PowerState): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { Accept: 'application/json' },
            });
            const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
            if (!response.ok) {
                // The starter's own words and its code, so a report can be searched back to it.
                const code = typeof body['code'] === 'string' ? ` (${body['code']})` : '';
                throw new Error(`${String(body['error'] ?? 'Der Starter hat nicht geantwortet.')}${code}`);
            }
            setState(next);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Der Starter ist nicht erreichbar.');
            throw cause;
        } finally {
            setBusy(false);
        }
    }, []);

    const start = useCallback(async () => {
        await act(START, 'running');
    }, [act]);

    const stop = useCallback(async () => {
        await act(STOP, 'stopped');
    }, [act]);

    const value = useMemo<PowerContext>(
        () => ({ state, known, busy, ...(error === undefined ? {} : { error }), start, stop, recheck }),
        [state, known, busy, error, start, stop, recheck]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePower(): PowerContext {
    const context = useContext(Context);
    if (context === undefined) {
        throw new Error('usePower outside PowerProvider');
    }
    return context;
}

/**
 * Whether to offer waking the machine rather than merely reporting no server.
 *
 * Only when the API is silent *and* a starter answered saying the service is stopped. Either alone
 * is not enough: a silent API with no starter is simply no server — `NoServerScreen` — and a
 * starter reporting a running service alongside a silent API is a fault, not something a start
 * would fix.
 */
export function shouldOfferWake(served: boolean, state: PowerState, known: boolean): boolean {
    return !served && known && state === 'stopped';
}
