import { useMemo } from 'react';

import { AccountProvider } from '../src/account.js';
import { PowerProvider } from '../src/power.js';
import { ApplyProvider } from '../src/apply.js';
import { buildMailbox } from '../src/data.js';
import { ModelProvider } from '../src/llm.js';
import { MailboxScope, type MailboxStatus } from '../src/mailbox.js';
import { LoginProvider } from '../src/login.js';
import { AppStateProvider } from '../src/state.js';
import { SyncProvider } from '../src/sync.js';
import { StoreProvider } from '../src/store.js';

import {
    DEMO_CATEGORY_CHANGES,
    DEMO_CATEGORY_OBSERVATIONS,
    DEMO_FOLDERS,
    DEMO_LABELS,
    DEMO_RULES,
    generateMailbox,
} from './fixtures/index.js';

/**
 * The providers the application mounts, in the order it mounts them.
 *
 * Kept in one place so a test cannot accidentally render a screen inside a shape the app never
 * uses — which is a way of passing that proves nothing. When a new provider is added to `App`, this
 * is the file that has to change, and every test picks it up.
 *
 * The mailbox is handed in through `MailboxScope` rather than fetched. `MailboxProvider` asks a
 * server, and there is none here — it used to fall back to a synthetic mailbox on its own, which is
 * precisely the behaviour that was removed. So the fixture is supplied explicitly, and what the
 * provider does with an answer, a 423 and a refused connection is tested where that lives.
 *
 * `StoreProvider` is opt-in: it seeds itself from the mailbox and carries staged changes, so tests
 * about a single component are clearer without it.
 */
export function Providers({
    children,
    withStore = false,
    withStreams = false,
    status,
}: {
    children: React.ReactNode;
    withStore?: boolean;
    /**
     * Mount the two providers that open an `EventSource`.
     *
     * Opt-in because happy-dom has no `EventSource`, so mounting them in a test that actually runs
     * effects throws before anything renders. Only a test of the whole shell needs them, and that
     * one renders to static markup, where effects never run.
     */
    withStreams?: boolean;
    /** Overrides for the copy's own facts — its age, what is missing from it, what was hidden. */
    status?: Partial<MailboxStatus>;
}): React.JSX.Element {
    const data = useMemo(
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
    const merged = useMemo<MailboxStatus>(() => ({ ...FIXTURE_STATUS, ...status }), [status]);

    return (
        <AccountProvider>
        <PowerProvider>
        <MailboxScope data={data} status={merged}>
            <AppStateProvider>
                <ModelProvider>
                    <Streams enabled={withStreams}>
                        <ApplyProvider>
                            {withStore ? <StoreProvider>{children}</StoreProvider> : children}
                        </ApplyProvider>
                    </Streams>
                </ModelProvider>
            </AppStateProvider>
        </MailboxScope>
        </PowerProvider>
        </AccountProvider>
    );
}

/** A copy that was synced, is complete, and has had nothing done to it yet. */
export const FIXTURE_STATUS: MailboxStatus = {
    syncedAt: 1_700_000_000,
    version: 'fixture',
    truncated: false,
    unreadable: [],
    history: [],
    historyLimit: undefined,
    hiddenSuggestions: [],
};

function Streams({
    enabled,
    children,
}: {
    enabled: boolean;
    children: React.ReactNode;
}): React.JSX.Element {
    if (!enabled) {
        return <>{children}</>;
    }
    return (
        <SyncProvider>
            <LoginProvider>{children}</LoginProvider>
        </SyncProvider>
    );
}
