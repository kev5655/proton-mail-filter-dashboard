import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The gate in front of the dashboard, and the state of the key behind it.
 *
 * This is not a login that guards a screen. Everything on the machine — the mailbox copy and the
 * stored Proton session — is encrypted with a key that only the password unwraps, so the password
 * is the reason the data is readable at all, and „gesperrt" means the server genuinely cannot open
 * the database rather than that this page is declining to show it.
 *
 * Three states matter and are kept apart on purpose:
 *
 *  - **no server** — `pnpm serve` is not running. There is nothing to unlock and nothing to show,
 *    so `NoServerScreen` says so; a password field would be a lie about what is there.
 *  - **not registered** — a first run. The screen asks for a password to *create*, and says what
 *    happens if it is lost, because there is no way back.
 *  - **registered and locked** — the ordinary state at start-up.
 */

export interface AccountStatus {
    /** Whether this server guards anything at all. False means no lock screen, ever. */
    available: boolean;
    registered: boolean;
    unlocked: boolean;
    /**
     * Whether the unlock has to say which account.
     *
     * Only where this installation has more than one. Optional so an older server, which never
     * sends it, reads as „one account" rather than as a broken response.
     */
    needsAccountName?: boolean;
    username?: string;
    requiresTotp: boolean;
    hasPasskeys: boolean;
    /** `unlocks` distinguishes a passkey that carries a wrapping of the key from a second factor. */
    passkeys: Array<{ id: string; label: string; addedAt: number; unlocks?: boolean }>;
    /**
     * Whether some passkey can open this account with no password.
     *
     * Optional so an older server, which never sends it, reads as „no" rather than as broken.
     */
    passkeyUnlock?: boolean;
    graceUntil?: number;
    graceMinutes: number;
    withinGrace: boolean;
    ready: boolean;
    problem?: string;
}

export interface AccountAction {
    action: string;
    [key: string]: unknown;
}

interface AccountContext {
    status: AccountStatus;
    /** False until the first answer arrives, so nothing renders a lock screen on a guess. */
    known: boolean;
    /** True when a local server answered at all. False means there is nothing to show. */
    served: boolean;
    /** Perform one action. Throws with the server's own message, which the forms show verbatim. */
    perform: (action: AccountAction) => Promise<unknown>;
    refresh: () => void;
}

const ENDPOINT = '/api/account';

/**
 * What the dashboard assumes before it has heard anything.
 *
 * Unlocked and ready, deliberately. The alternative — assume locked — puts a password field on
 * screen for as long as a fetch takes, and permanently where there is no server at all. `known`
 * is what the gate waits for; this is only what it reads before the answer arrives.
 */
const OPEN: AccountStatus = {
    available: false,
    registered: false,
    unlocked: true,
    needsAccountName: false,
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 0,
    withinGrace: false,
    ready: true,
};

const Context = createContext<AccountContext | undefined>(undefined);

export function AccountProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [status, setStatus] = useState<AccountStatus>(OPEN);
    const [known, setKnown] = useState(false);
    const [served, setServed] = useState(false);

    const refresh = useCallback(() => {
        void (async () => {
            try {
                const response = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
                if (!response.ok) {
                    throw new Error(String(response.status));
                }
                setStatus((await response.json()) as AccountStatus);
                setServed(true);
            } catch {
                // No server, or one that does not know the route. Both mean there is nothing here
                // to lock, and nothing to show either.
                setStatus(OPEN);
                setServed(false);
            } finally {
                setKnown(true);
            }
        })();
    }, []);

    useEffect(refresh, [refresh]);

    const perform = useCallback(async (action: AccountAction): Promise<unknown> => {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action),
        });
        const body = (await response.json()) as Record<string, unknown>;

        if (!response.ok) {
            // The server's own sentence, with its hint. Rewording a refusal here would produce two
            // wordings for one refusal, and the one the user can search for would be the other one.
            const error = new Error(String(body['error'] ?? 'Unbekannter Fehler.'));
            Object.assign(error, { code: body['code'], hint: body['hint'] });
            throw error;
        }

        // Every successful action answers with the new state, so nothing has to ask twice.
        if (typeof body['registered'] === 'boolean') {
            setStatus(body as unknown as AccountStatus);
            setServed(true);
        }
        return body;
    }, []);

    const value = useMemo<AccountContext>(
        () => ({ status, known, served, perform, refresh }),
        [status, known, served, perform, refresh]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccount(): AccountContext {
    const context = useContext(Context);
    if (context === undefined) {
        throw new Error('useAccount outside AccountProvider');
    }
    return context;
}

/**
 * Whether the dashboard should be behind the lock screen.
 *
 * Only when a server actually answered, has an account surface, and says it is not open. No
 * server is not „locked" — it is `NoServerScreen`, decided before this is asked — and a server
 * without an account surface has nothing to check a password against.
 */
export function isLocked(status: AccountStatus, known: boolean, served: boolean): boolean {
    if (!known || !served || !status.available) {
        return false;
    }
    return !status.registered || !status.unlocked;
}
