import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type {
    HiddenSuggestionDto,
    JournalEntryDto,
    MailboxSnapshot,
    UnreadableRule,
} from '@pms/server/types';

import { useAccount } from './account.js';
import { buildMailbox, type MailboxData } from './data.js';

/**
 * The mailbox the dashboard is looking at — the real one, or none.
 *
 * There used to be a second source here: a synthetic mailbox the dashboard fell back to whenever
 * the local server did not answer. It was removed, and the reason is not tidiness. `!response.ok`
 * covered **423 as well** — a running server whose vault is locked — so a locked account produced a
 * dashboard full of invented mail with no lock screen, no sign-in button and no way out of it
 * except knowing to restart something. A stand-in that appears when the real thing is merely shut
 * is indistinguishable from a broken tool, and it hid the one state the user needed to see.
 *
 * So there is one source. Every reason the mirror cannot be shown is now a state with a sentence
 * and a way onward: the server is not running, the vault is locked, the answer was unusable. None
 * of them renders the dashboard, which means nothing below here has to ask which mailbox it has.
 *
 * The server is asked once and never polled. The copy it serves changes only when a sync runs, so
 * polling would spend requests to re-read a file that has not moved; the timestamp on screen is
 * what tells the user how old the answer is.
 */

export interface MailboxStatus {
    /** Unix seconds of the last completed sync. */
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
    /**
     * What this tool changed at the account, newest first.
     *
     * Part of the status rather than of `MailboxData`, because it is not a fact about the mailbox —
     * it is a fact about what we did to it, and it comes from a different table for a different
     * reason.
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
     * device sees the same list.
     */
    hiddenSuggestions: HiddenSuggestionDto[];
}

interface MailboxContext {
    data: MailboxData;
    status: MailboxStatus;
    /** Ask again — after a sync, the copy on disk is not the one in memory. */
    reload: () => void;
}

const Context = createContext<MailboxContext | undefined>(undefined);

/** The endpoint the vite dev server proxies to the local server. */
const ENDPOINT = '/api/mailbox';

/** Why the mirror cannot be shown. Each one is a screen, and none of them is a mailbox. */
interface Failure {
    message: string;
    /** The HTTP status, where something answered. `423` is the locked vault and is handled apart. */
    status: number | undefined;
}

type Load =
    | { kind: 'loading' }
    | { kind: 'ready'; data: MailboxData; status: MailboxStatus }
    | { kind: 'failed'; failure: Failure };

export function MailboxProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
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
                    if (cancelled) {
                        return;
                    }
                    setLoad({
                        kind: 'failed',
                        failure: { message: describeStatus(response.status), status: response.status },
                    });
                    return;
                }
                const snapshot = (await response.json()) as MailboxSnapshot;
                if (cancelled) {
                    return;
                }
                setLoad({
                    kind: 'ready',
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
                        syncedAt: snapshot.meta.syncedAt,
                        version: snapshot.meta.version,
                        truncated: snapshot.meta.truncated,
                        unreadable: snapshot.unreadable,
                        history: snapshot.history ?? [],
                        historyLimit: snapshot.meta.historyLimit,
                        // Absent against a server from before this existed; an empty list is the
                        // honest reading of that — nothing has been put away yet.
                        hiddenSuggestions: snapshot.hiddenSuggestions ?? [],
                    },
                });
            } catch (cause) {
                if (!cancelled) {
                    setLoad({ kind: 'failed', failure: describeProblem(cause) });
                }
            }
        })();

        return () => {
            cancelled = true;
            abort.abort();
        };
    }, [attempt]);

    if (load.kind !== 'ready') {
        // Deliberately not `children`. There is no mailbox, so there is nothing for the dashboard
        // to render, and rendering it against an empty one would put a plausible screen in front of
        // somebody whose account is simply not open.
        return load.kind === 'loading' ? (
            <div className="lock-screen" />
        ) : (
            <MailboxProblem failure={load.failure} retry={reload} />
        );
    }

    return (
        <MailboxScope data={load.data} status={load.status} reload={reload}>
            {children}
        </MailboxScope>
    );
}

/**
 * One mailbox, handed to the screens.
 *
 * Separated from the fetching above so a test can supply a mailbox without a server and still go
 * through the same context, the same `buildMailbox` and the same screens. That is a seam, not a
 * second mode: it holds no data of its own and has no fallback, so there is nothing here that could
 * appear in front of a user. What it cannot exercise — the request and its failures — is what
 * `mailbox-source.test.tsx` covers directly.
 */
export function MailboxScope({
    data,
    status,
    reload = () => undefined,
    children,
}: {
    data: MailboxData;
    status: MailboxStatus;
    reload?: () => void;
    children: React.ReactNode;
}): React.JSX.Element {
    const value = useMemo<MailboxContext>(
        () => ({ data, status, reload }),
        [data, status, reload]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * The mirror could not be read, and why.
 *
 * A locked vault is the one case with somewhere to go rather than something to retry: the gate
 * above already knows how to ask for the password, so this asks the account to say so again and
 * gets out of the way. It happens when the vault locks while the dashboard is open — the grace
 * period running out, or „Sperren" on another device.
 */
function MailboxProblem({ failure, retry }: { failure: Failure; retry: () => void }): React.JSX.Element {
    const { refresh } = useAccount();
    const locked = failure.status === 423;

    return (
        <div className="lock-screen">
            <div className="lock-card">
                <div className="stack">
                    <h1>{locked ? 'Gesperrt' : 'Das Postfach ist nicht lesbar'}</h1>
                    <p className="faint">{failure.message}</p>
                    <button
                        type="button"
                        className="button"
                        onClick={() => {
                            if (locked) {
                                refresh();
                                return;
                            }
                            retry();
                        }}
                    >
                        {locked ? 'Zum Sperrbildschirm' : 'Noch einmal versuchen'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** What a status code means, in the words the screen shows. */
function describeStatus(status: number): string {
    if (status === 423) {
        return 'Der Tresor ist zu. Die lokale Kopie ist verschlüsselt, und ohne dein Passwort kann der Server sie nicht öffnen.';
    }
    if (status === 404) {
        return 'Der Server kennt diese Route nicht. Das ist eine ältere Fassung, als das Dashboard erwartet.';
    }
    return `Der Server antwortete mit ${status}.`;
}

/**
 * A failed fetch, in words.
 *
 * A refused connection used to be the ordinary case, because it meant the demo. It is now what it
 * always actually was: the server is not running, and that is worth saying plainly rather than
 * papering over.
 */
function describeProblem(cause: unknown): Failure {
    if (cause instanceof TypeError) {
        return {
            message:
                'Kein lokaler Server erreichbar. Starte ihn mit „pnpm serve" — das Dashboard zeigt nur das echte Postfach.',
            status: undefined,
        };
    }
    // Our own doing — the page went away mid-request. Nothing to report, but nothing to show either.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
        return { message: 'Die Anfrage wurde abgebrochen.', status: undefined };
    }
    return {
        message:
            cause instanceof Error ? cause.message : 'Der lokale Server hat unerwartet geantwortet.',
        status: undefined,
    };
}

export function useMailbox(): MailboxData {
    return useMailboxContext().data;
}

/** Re-read the mirror. Used after a sync, when the copy on disk has moved on. */
export function useReloadMailbox(): () => void {
    return useMailboxContext().reload;
}

export function useMailboxStatus(): MailboxStatus {
    return useMailboxContext().status;
}

function useMailboxContext(): MailboxContext {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useMailbox outside MailboxProvider');
    }
    return value;
}
