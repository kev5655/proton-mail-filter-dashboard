import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { ChangePlan, PendingChange } from '@pms/changes';

import { log } from './log.js';

/**
 * Offering a change to the account, and waiting for a person to allow it.
 *
 * The request goes over HTTP and comes back `202` with a reference and six characters. Nothing has
 * been written at that point and nothing will be until somebody types „ja" in the terminal where
 * `pnpm serve` runs — which is why this waits by polling rather than by awaiting a response.
 *
 * The six characters are shown here as well. If the terminal is asking about a different change
 * than the one on this screen, the two do not match and there is something to notice.
 */

/** What a finished change left behind, kept after the dialog has closed. */
export interface ApplyResult {
    summary: string;
    backupPath: string;
    partial: string | undefined;
    at: number;
}

export type ApplyPhase =
    | { phase: 'idle' }
    | { phase: 'offering' }
    | { phase: 'waiting'; requestId: string; shortDigest: string }
    | { phase: 'applied'; backupPath: string; partial: string | undefined }
    | { phase: 'failed'; error: string; code: string | undefined };

interface ApplyContextValue {
    phase: ApplyPhase;
    /** Offer a staged change. Resolves when the offer was accepted for consideration, not applied. */
    offer: (change: PendingChange, plan: ChangePlan, applyToExisting: boolean) => void;
    reset: () => void;
    /**
     * The last change that actually landed.
     *
     * Outlives the dialog on purpose. The dialog closes when the change is done — leaving it open
     * on a success message makes a finished job look unfinished — but where the backup went, and
     * whether the result was partial, are things somebody may want to read a minute later.
     */
    result: ApplyResult | undefined;
    dismissResult: () => void;
}

const Context = createContext<ApplyContextValue | undefined>(undefined);

export function ApplyProvider({
    children,
    onApplied,
}: {
    children: React.ReactNode;
    onApplied?: (() => void) | undefined;
}): React.JSX.Element {
    const [phase, setPhase] = useState<ApplyPhase>({ phase: 'idle' });
    const [result, setResult] = useState<ApplyResult | undefined>(undefined);

    const offer = useCallback(
        (change: PendingChange, plan: ChangePlan, applyToExisting: boolean) => {
            setPhase({ phase: 'offering' });

            void (async () => {
                try {
                    const version = await currentVersion();
                    const response = await fetch('/api/apply', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            requestId: `req-${String(Date.now())}`,
                            createdAt: Date.now(),
                            change,
                            plan,
                            affectedMessageIds: plan.moves.map((move) => move.messageId),
                            applyToExisting,
                            baseVersion: version,
                        }),
                    });

                    const body = (await response.json()) as {
                        requestId?: string;
                        shortDigest?: string;
                        error?: string;
                        code?: string;
                    };

                    if (!response.ok || body.requestId === undefined) {
                        setPhase({
                            phase: 'failed',
                            error: body.error ?? `Der Server antwortete mit ${String(response.status)}.`,
                            code: body.code,
                        });
                        return;
                    }

                    log('info', 'apply.offered', { kind: change.kind, moves: plan.moves.length });
                    setPhase({
                        phase: 'waiting',
                        requestId: body.requestId,
                        shortDigest: body.shortDigest ?? '???-???',
                    });

                    await watch(body.requestId, setPhase, onApplied, (applied) => {
                        setResult({ ...applied, summary: change.summary, at: Date.now() });
                    });
                } catch {
                    setPhase({
                        phase: 'failed',
                        error: 'Der lokale Server ist nicht erreichbar. Läuft `pnpm serve`?',
                        code: undefined,
                    });
                }
            })();
        },
        [onApplied]
    );

    const reset = useCallback(() => {
        setPhase({ phase: 'idle' });
    }, []);

    const dismissResult = useCallback(() => {
        setResult(undefined);
    }, []);

    const value = useMemo<ApplyContextValue>(
        () => ({ phase, offer, reset, result, dismissResult }),
        [phase, offer, reset, result, dismissResult]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useApply(): ApplyContextValue {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useApply outside ApplyProvider');
    }
    return value;
}

/**
 * The fingerprint the plan was computed against.
 *
 * Asked of the server rather than computed here: the browser sees a mirror, and what matters is
 * what the account looked like when the mirror was made. The server refuses the write if the
 * account has moved on since.
 */
async function currentVersion(): Promise<string> {
    const response = await fetch('/api/mailbox', { headers: { Accept: 'application/json' } });
    const snapshot = (await response.json()) as { meta?: { version?: string } };
    return snapshot.meta?.version ?? '';
}

/** Poll while the terminal asks. Slow on purpose: someone is reading a diff, not a spinner. */
async function watch(
    requestId: string,
    setPhase: (phase: ApplyPhase) => void,
    onApplied: (() => void) | undefined,
    onResult: (result: { backupPath: string; partial: string | undefined }) => void
): Promise<void> {
    for (let attempt = 0; attempt < 240; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const response = await fetch(`/api/apply/${requestId}`);
        if (!response.ok) {
            continue;
        }
        const state = (await response.json()) as {
            state: string;
            backupPath?: string;
            partial?: string;
            error?: string;
            code?: string;
        };

        if (state.state === 'applied') {
            log('info', 'apply.applied', { partial: state.partial !== undefined });
            setPhase({
                phase: 'applied',
                backupPath: state.backupPath ?? '',
                partial: state.partial,
            });
            onResult({ backupPath: state.backupPath ?? '', partial: state.partial });
            onApplied?.();
            return;
        }
        if (state.state === 'failed') {
            log('warn', 'apply.failed', { code: state.code ?? 'unknown' });
            setPhase({ phase: 'failed', error: state.error ?? 'Unbekannter Fehler.', code: state.code });
            return;
        }
    }

    setPhase({
        phase: 'failed',
        error: 'Keine Antwort aus dem Terminal. Wurde die Rückfrage übersehen?',
        code: 'APPLY_CONFIRMATION_EXPIRED',
    });
}
