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
    | { state: 'failed'; error: string; code?: string; finishedAt: number };

interface LoginContext {
    status: LoginState & { available: boolean };
    /** True while the stream is connected — i.e. `pnpm serve` is running. */
    connected: boolean;
    start: () => void;
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
    const [status, setStatus] = useState<LoginState & { available: boolean }>({
        state: 'idle',
        available: false,
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
            const next = JSON.parse(event.data as string) as LoginState & { available: boolean };
            setStatus(next);
            if (next.state === 'done') {
                log('info', 'login.done', {});
                onSignedIn?.();
            }
            if (next.state === 'failed') {
                log('warn', 'login.failed', { code: next.code ?? 'unknown' });
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

    const value = useMemo<LoginContext>(
        () => ({ status, connected, start, refusal }),
        [status, connected, start, refusal]
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
