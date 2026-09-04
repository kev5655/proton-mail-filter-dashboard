import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { DEMO_FOLDERS, DEMO_RULES, generateMailbox } from '@pms/demo';
import type { MailboxSnapshot, UnreadableRule } from '@pms/server/types';

import { buildMailbox, type MailboxData } from './data.js';

/**
 * Which mailbox the dashboard is looking at.
 *
 * Two sources, one set of screens. The local server hands over a mirror of the real account when it
 * is running; otherwise the demo mailbox stands in. The screens are given the same shape either way
 * and cannot tell the difference — which is the only way the demo keeps being worth having.
 *
 * The server is asked once, at startup, and never polled. The copy it serves changes only when
 * `pnpm sync` runs, so polling would spend requests to re-read a file that has not moved; the
 * timestamp on screen is what tells the user how old the answer is.
 *
 * Falling back is not an error path. Nobody has to start a server to look at the demo, so a refused
 * connection is the ordinary case and is reported as a state, not as a failure.
 */

export type MailboxSource = 'demo' | 'proton';

export interface MailboxStatus {
    source: MailboxSource;
    /** Unix seconds of the last completed sync. Only ever set for the real mailbox. */
    syncedAt: number | undefined;
    /** True when the local copy is known to be incomplete because a sync hit its limit. */
    truncated: boolean;
    /** Filters that are in the account but could not be read as rules. */
    unreadable: UnreadableRule[];
    /** Set when a server answered but its reply could not be used. */
    problem: string | undefined;
}

interface MailboxContext {
    data: MailboxData;
    status: MailboxStatus;
    /** True until the server has been asked. The screens render the demo meanwhile. */
    loading: boolean;
}

const Context = createContext<MailboxContext | undefined>(undefined);

/** The endpoint the vite dev server proxies to the local server. */
const ENDPOINT = '/api/mailbox';

const DEMO_STATUS: MailboxStatus = {
    source: 'demo',
    syncedAt: undefined,
    truncated: false,
    unreadable: [],
    problem: undefined,
};

export function MailboxProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    // Built once. The demo mailbox is generated, and regenerating it on a re-render would reshuffle
    // every list under the user.
    const demo = useMemo(
        () => buildMailbox({ messages: generateMailbox(), folders: DEMO_FOLDERS, rules: DEMO_RULES }),
        []
    );

    const [remote, setRemote] = useState<{ data: MailboxData; status: MailboxStatus } | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        // Aborted rather than merely ignored on unmount: a `cancelled` flag stops the result being
        // used but leaves the request running, which in a test teardown becomes a rejected promise
        // nobody is left to catch.
        const abort = new AbortController();

        void (async () => {
            try {
                const response = await fetch(ENDPOINT, {
                    headers: { Accept: 'application/json' },
                    signal: abort.signal,
                });
                if (!response.ok) {
                    throw new Error(`Der Server antwortete mit ${response.status}.`);
                }
                const snapshot = (await response.json()) as MailboxSnapshot;
                if (cancelled) {
                    return;
                }
                setRemote({
                    data: buildMailbox({
                        messages: snapshot.messages,
                        folders: snapshot.folders,
                        rules: snapshot.rules,
                    }),
                    status: {
                        source: 'proton',
                        syncedAt: snapshot.meta.syncedAt,
                        truncated: snapshot.meta.truncated,
                        unreadable: snapshot.unreadable,
                        problem: undefined,
                    },
                });
            } catch (cause) {
                // No server is the normal case; a server that answered badly is not. Only the
                // second is worth putting on screen, and telling them apart is the reason this
                // catch does not simply fall silent.
                if (!cancelled) {
                    setProblem(describeProblem(cause));
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
            abort.abort();
        };
    }, []);

    const value = useMemo<MailboxContext>(
        () =>
            remote === undefined
                ? { data: demo, status: { ...DEMO_STATUS, problem }, loading }
                : { data: remote.data, status: remote.status, loading: false },
        [demo, remote, problem, loading]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * A failed fetch, in words.
 *
 * A refused connection means the server is simply not running, which is not a problem to report.
 * Anything else is, because it means something answered and the answer was unusable.
 */
function describeProblem(cause: unknown): string | undefined {
    if (cause instanceof TypeError) {
        return undefined;
    }
    // Our own doing — the page went away mid-request. Not something to report to the user.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
        return undefined;
    }
    return cause instanceof Error ? cause.message : 'Der lokale Server hat unerwartet geantwortet.';
}

export function useMailbox(): MailboxData {
    return useMailboxContext().data;
}

export function useMailboxStatus(): MailboxStatus & { loading: boolean } {
    const { status, loading } = useMailboxContext();
    return { ...status, loading };
}

function useMailboxContext(): MailboxContext {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useMailbox outside MailboxProvider');
    }
    return value;
}
