import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { log } from './log.js';

/**
 * Signing in, from the dashboard.
 *
 * Clicking here does not perform a login. It asks the process that holds the session to open
 * Proton's own login page in a real browser profile — and then everything that matters happens in
 * that window, where a password manager's extension can fill the form and a passkey has an
 * authenticator to talk to. No password passes through this page, this server, or that process.
 *
 * The state arrives over a stream rather than by polling, because a login is mostly waiting: for a
 * window to open, and then for a person. Polling would either be slow to notice or noisy while
 * nothing happened.
 */

export type LoginState =
    | { state: 'idle' }
    | { state: 'refused'; reason: string; code: string }
    | { state: 'opening'; startedAt: number }
    | { state: 'waiting'; startedAt: number }
    | { state: 'done'; finishedAt: number }
    | { state: 'disconnecting'; startedAt: number }
    | { state: 'disconnected'; revoked: boolean; revokeError?: string; finishedAt: number }
    | { state: 'failed'; error: string; code?: string; finishedAt: number };

interface LoginContext {
    status: LoginState & { available: boolean; signedIn: boolean };
    /** True while the stream is connected — i.e. `pnpm serve` is running. */
    connected: boolean;
    start: () => void;
    /**
     * Cut the connection. `everywhere` also asks Proton to revoke the token.
     *
     * The two are a real choice rather than a checkbox for tidiness: forgetting locally always
     * works, revoking is one request that can fail — and the screen has to be able to say which of
     * the two actually happened.
     */
    disconnect: (everywhere: boolean) => void;
    /** Set when starting was refused: a login already running, or a server that cannot open one. */
    refusal: string | undefined;
}

const Context = createContext<LoginContext | undefined>(undefined);

const STREAM = '/api/login/stream';
const START = '/api/login';

export function LoginProvider({
    children,
    onSignedIn,
}: {
    children: React.ReactNode;
    onSignedIn?: (() => void) | undefined;
}): React.JSX.Element {
    const [status, setStatus] = useState<LoginState & { available: boolean; signedIn: boolean }>({
        state: 'idle',
        available: false,
        signedIn: false,
    });
    const [connected, setConnected] = useState(false);
    const [refusal, setRefusal] = useState<string | undefined>(undefined);

    useEffect(() => {
        const source = new EventSource(STREAM);

        source.onopen = () => {
            setConnected(true);
        };
        source.onerror = () => {
            setConnected(false);
        };
        source.onmessage = (event) => {
            const next = JSON.parse(event.data as string) as LoginState & {
                available: boolean;
                signedIn: boolean;
            };
            setStatus(next);
            if (next.state === 'done') {
                log('info', 'login.done', {});
                onSignedIn?.();
            }
            if (next.state === 'failed') {
                log('warn', 'login.failed', { code: next.code ?? 'unknown' });
            }
            if (next.state === 'disconnected') {
                log('info', 'login.disconnected', { revoked: next.revoked });
                // The mailbox copy is gone with the connection, so what is on screen now describes
                // nothing. Asking again is how the dashboard falls back to the demo honestly.
                onSignedIn?.();
            }
        };

        return () => {
            source.close();
        };
    }, [onSignedIn]);

    const start = useCallback(() => {
        setRefusal(undefined);
        void (async () => {
            try {
                const response = await fetch(START, { method: 'POST' });
                if (!response.ok) {
                    const body = (await response.json()) as { error?: string };
                    setRefusal(body.error ?? `Der Server antwortete mit ${String(response.status)}.`);
                }
            } catch {
                setRefusal('Der lokale Server ist nicht erreichbar. Läuft `pnpm serve`?');
            }
        })();
    }, []);

    const disconnect = useCallback((everywhere: boolean) => {
        setRefusal(undefined);
        void (async () => {
            try {
                const response = await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ everywhere }),
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

    const value = useMemo<LoginContext>(
        () => ({ status, connected, start, disconnect, refusal }),
        [status, connected, start, disconnect, refusal]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLogin(): LoginContext {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useLogin outside LoginProvider');
    }
    return value;
}
