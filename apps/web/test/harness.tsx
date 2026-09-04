import { AccountProvider } from '../src/account.js';
import { ApplyProvider } from '../src/apply.js';
import { ModelProvider } from '../src/llm.js';
import { MailboxProvider } from '../src/mailbox.js';
import { AppStateProvider } from '../src/state.js';
import { StoreProvider } from '../src/store.js';

/**
 * The providers the application mounts, in the order it mounts them.
 *
 * Kept in one place so a test cannot accidentally render a screen inside a shape the app never
 * uses — which is a way of passing that proves nothing. When a new provider is added to `App`, this
 * is the file that has to change, and every test picks it up.
 *
 * `StoreProvider` is opt-in: it seeds itself from the mailbox and carries staged changes, so tests
 * about a single component are clearer without it.
 */
export function Providers({
    children,
    withStore = false,
}: {
    children: React.ReactNode;
    withStore?: boolean;
}): React.JSX.Element {
    return (
        <AccountProvider>
        <MailboxProvider>
            <AppStateProvider>
                <ModelProvider>
                    <ApplyProvider>
                        {withStore ? <StoreProvider>{children}</StoreProvider> : children}
                    </ApplyProvider>
                </ModelProvider>
            </AppStateProvider>
        </MailboxProvider>
        </AccountProvider>
    );
}
