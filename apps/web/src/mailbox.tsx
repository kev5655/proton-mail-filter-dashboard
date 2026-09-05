import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
    DEMO_CATEGORY_CHANGES,
    DEMO_CATEGORY_OBSERVATIONS,
    DEMO_FOLDERS,
    DEMO_LABELS,
    DEMO_RULES,
    generateMailbox,
} from '@pms/demo';
import type {
    HiddenSuggestionDto,
    JournalEntryDto,
    MailboxSnapshot,
    UnreadableRule,
} from '@pms/server/types';

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
    /**
     * The account's fingerprint — filters and folders as they were when this copy was made.
     *
     * Carried into the interface because it answers a question `syncedAt` cannot: *has the account
     * changed shape?* A write changes it, because the server re-reads the folders and filters
     * straight afterwards; a sync that finds nothing new leaves it alone. That distinction is what
     * lets a screen holding derived state know when to start over.
     */
    version: string | undefined;
    /** True when the local copy is known to be incomplete because a sync hit its limit. */
    truncated: boolean;
    /** Filters that are in the account but could not be read as rules. */
    unreadable: UnreadableRule[];
    /** Set when a server answered but its reply could not be used. */
    problem: string | undefined;
    /**
     * What this tool changed at the account, newest first.
     *
     * Part of the status rather than of `MailboxData`, because it is not a fact about the mailbox —
     * it is a fact about what we did to it, and it comes from a different table for a different
     * reason. The demo has none: nothing there ever reached an account.
     */
    history: JournalEntryDto[];
    /**
     * How many changes the record keeps, as the server reports it.
     *
     * Carried rather than restated here: it is the journal's number, and two copies of one number
     * drift. Undefined against an older server, and the screen simply says nothing then.
     */
    historyLimit: number | undefined;
    /**
     * Which suggestions have been put away, newest first.
     *
     * Beside the history for the same reason: not a fact about the mailbox but about a decision
     * somebody made about it, kept in the local database so it survives a reload and so a second
     * device sees the same list. The demo keeps its own in memory — there is nowhere to write to.
     */
    hiddenSuggestions: HiddenSuggestionDto[];
}

interface MailboxContext {
    data: MailboxData;
    status: MailboxStatus;
    /** True until the server has been asked. The screens render the demo meanwhile. */
    loading: boolean;
    /** Ask again — after a sync, the copy on disk is not the one in memory. */
    reload: () => void;
}

const Context = createContext<MailboxContext | undefined>(undefined);

/** The endpoint the vite dev server proxies to the local server. */
const ENDPOINT = '/api/mailbox';

const DEMO_STATUS: MailboxStatus = {
    source: 'demo',
    syncedAt: undefined,
    version: undefined,
    truncated: false,
    unreadable: [],
    problem: undefined,
    history: [],
    historyLimit: undefined,
    hiddenSuggestions: [],
};

export function MailboxProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    // Built once. The demo mailbox is generated, and regenerating it on a re-render would reshuffle
    // every list under the user.
    const demo = useMemo(
        () =>
            buildMailbox({
                messages: generateMailbox(),
                folders: DEMO_FOLDERS,
                labels: DEMO_LABELS,
                rules: DEMO_RULES,
                categoryObservations: DEMO_CATEGORY_OBSERVATIONS,
                categoryChanges: DEMO_CATEGORY_CHANGES,
            }),
        []
    );

    const [remote, setRemote] = useState<{ data: MailboxData; status: MailboxStatus } | undefined>();
    const [problem, setProblem] = useState<string | undefined>();
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);

    const reload = useCallback(() => {
        setAttempt((current) => current + 1);
    }, []);

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
                        // Not discarded any more. Without them every real label was reported to
                        // the user as an unknown Proton category, and no rule could mark mail
                        // rather than move it.
                        labels: snapshot.labels ?? [],
                        rules: snapshot.rules,
                        // Absent on a copy made before the history existed. That is a real state
                        // with a real answer — "not enough looks yet" — rather than a gap.
                        categoryObservations: snapshot.categoryObservations ?? [],
                        categoryChanges: snapshot.categoryChanges ?? [],
                    }),
                    status: {
                        source: 'proton',
                        syncedAt: snapshot.meta.syncedAt,
                        version: snapshot.meta.version,
                        truncated: snapshot.meta.truncated,
                        unreadable: snapshot.unreadable,
                        problem: undefined,
                        history: snapshot.history ?? [],
                        historyLimit: snapshot.meta.historyLimit,
                        // Absent against a server from before this existed; an empty list is the
                        // honest reading of that — nothing has been put away yet.
                        hiddenSuggestions: snapshot.hiddenSuggestions ?? [],
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
    }, [attempt]);

    const value = useMemo<MailboxContext>(
        () =>
            remote === undefined
                ? { data: demo, status: { ...DEMO_STATUS, problem }, loading, reload }
                : { data: remote.data, status: remote.status, loading: false, reload },
        [demo, remote, problem, loading, reload]
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

/** Re-read the mirror. Used after a sync, when the copy on disk has moved on. */
export function useReloadMailbox(): () => void {
    return useMailboxContext().reload;
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
