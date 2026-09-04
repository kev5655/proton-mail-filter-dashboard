import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { SyncProgressEvent, SyncState } from '@pms/server/types';

import { log } from './log.js';

/**
 * Watching a sync from the browser.
 *
 * The stream is opened whether or not a sync is running, and the server answers with the current
 * state on connect — so a page reloaded halfway through a long run shows the run in flight rather
 * than an idle bar next to a busy server.
 *
 * Starting one is the single request in this application that is not a `GET`. It reads at Proton and
 * writes only into the local mirror, which is why it needs no confirmation; anything that would
 * change the account does not come this way at all.
 */

export type SyncStatus = (SyncState | { state: 'idle' }) & { available: boolean };

interface SyncContext {
    status: SyncStatus;
    /** Connected to the stream. False means the server is not there, or not reachable. */
    connected: boolean;
    start: (intervalMinutes?: number) => void;
    /** Set when starting was refused — a run already going, or a server that cannot sync. */
    refusal: string | undefined;
}

const Context = createContext<SyncContext | undefined>(undefined);

const STREAM = '/api/sync/stream';
const START = '/api/sync';

export function SyncProvider({
    children,
    onFinished,
}: {
    children: React.ReactNode;
    /** Called once per completed run, so the mailbox can be re-read. */
    onFinished?: (() => void) | undefined;
}): React.JSX.Element {
    const [status, setStatus] = useState<SyncStatus>({ state: 'idle', available: false });
    const [connected, setConnected] = useState(false);
    const [refusal, setRefusal] = useState<string | undefined>();

    useEffect(() => {
        const source = new EventSource(STREAM);

        source.addEventListener('open', () => {
            setConnected(true);
        });

        source.addEventListener('message', (event: MessageEvent<string>) => {
            let next: SyncStatus;
            try {
                next = JSON.parse(event.data) as SyncStatus;
            } catch {
                return;
            }
            setConnected(true);
            setStatus((previous) => {
                if (previous.state === 'running' && next.state === 'done') {
                    log('info', 'sync.finished', {
                        messages: next.summary.messages,
                        truncated: next.summary.truncated,
                    });
                    onFinished?.();
                }
                return next;
            });
        });

        source.addEventListener('error', () => {
            // No server, or it went away. Not a failure to report: nobody has to run one.
            setConnected(false);
        });

        return () => {
            source.close();
        };
    }, [onFinished]);

    /**
     * Start a sync, and tell the server what rhythm to keep afterwards.
     *
     * The interval rides on this request rather than on one of its own: the server promises exactly
     * two non-GET routes, and a local timer is not worth spending the third on. It also means the
     * setting takes hold at a moment the user can see — the next manual sync — rather than at some
     * point they have to trust.
     */
    const start = useCallback((intervalMinutes?: number) => {
        setRefusal(undefined);
        void (async () => {
            try {
                const response = await fetch(START, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        intervalMinutes === undefined ? {} : { intervalMinutes }
                    ),
                });
                if (!response.ok) {
                    const body = (await response.json()) as { error?: string };
                    setRefusal(body.error ?? `Der Server antwortete mit ${String(response.status)}.`);
                }
            } catch {
                setRefusal('Der lokale Server ist nicht erreichbar.');
            }
        })();
    }, []);

    const value = useMemo<SyncContext>(
        () => ({ status, connected, start, refusal }),
        [status, connected, start, refusal]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSync(): SyncContext {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useSync outside SyncProvider');
    }
    return value;
}

/** German names for the stages, so the bar says what is happening rather than how far it is. */
export const STAGE_NAMES: Record<SyncProgressEvent['stage'], string> = {
    labels: 'Ordner und Labels',
    filters: 'Filter',
    messages: 'Mails',
};
