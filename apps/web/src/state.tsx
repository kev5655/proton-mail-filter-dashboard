import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { ListableMessage } from './components/MailList.js';

/**
 * The bits of state that more than one screen needs: where you are, what you have selected, and
 * which message is open.
 *
 * Selection is deliberately global rather than per-list. Mail that belongs together rarely sits in
 * one place — a few from a rule's preview, a few more from a group — and a selection that resets
 * when you look somewhere else would make the manual path useless exactly when it is needed.
 */

export type Page = 'rules' | 'triage' | 'folders';

export interface Navigation {
    page: Page;
    /** Set when arriving from somewhere that pointed at one rule, e.g. a folder. */
    focusRuleId?: string | undefined;
    focusFolder?: string | undefined;
}

interface AppState {
    nav: Navigation;
    goTo: (nav: Navigation) => void;

    selected: ListableMessage[];
    isSelected: (id: string) => boolean;
    toggleSelection: (message: ListableMessage) => void;
    selectMany: (messages: ListableMessage[]) => void;
    clearSelection: () => void;

    open: ListableMessage | undefined;
    setOpen: (message: ListableMessage | undefined) => void;
}

const Context = createContext<AppState | undefined>(undefined);

export function AppStateProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    const [nav, setNav] = useState<Navigation>({ page: 'triage' });
    const [selected, setSelected] = useState<ListableMessage[]>([]);
    const [open, setOpen] = useState<ListableMessage | undefined>(undefined);

    const toggleSelection = useCallback((message: ListableMessage) => {
        setSelected((current) =>
            current.some((entry) => entry.ID === message.ID)
                ? current.filter((entry) => entry.ID !== message.ID)
                : [...current, message]
        );
    }, []);

    const selectMany = useCallback((messages: ListableMessage[]) => {
        setSelected((current) => {
            const known = new Set(current.map((entry) => entry.ID));
            return [...current, ...messages.filter((message) => !known.has(message.ID))];
        });
    }, []);

    const value = useMemo<AppState>(
        () => ({
            nav,
            goTo: setNav,
            selected,
            isSelected: (id) => selected.some((entry) => entry.ID === id),
            toggleSelection,
            selectMany,
            clearSelection: () => setSelected([]),
            open,
            setOpen,
        }),
        [nav, selected, open, toggleSelection, selectMany]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppState(): AppState {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useAppState outside AppStateProvider');
    }
    return value;
}
