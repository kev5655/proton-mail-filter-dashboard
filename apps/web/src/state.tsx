import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import type { ListableMessage } from './components/MailList.js';

/**
 * The bits of state that more than one screen needs: where you are, what you have selected, and
 * which message is open.
 *
 * Selection is deliberately global rather than per-list. Mail that belongs together rarely sits in
 * one place — a few from a rule's preview, a few more from a group — and a selection that resets
 * when you look somewhere else would make the manual path useless exactly when it is needed.
 *
 * The cost of that is a selection bar appearing on a screen that has nothing to do with where the
 * mail was picked, which reads as a bug. So the selection also remembers which screens it came
 * from, and the bar says so — persistence that explains itself rather than persistence that has to
 * be taken on trust.
 */

export type Page =
    | 'rules'
    | 'triage'
    | 'categories'
    | 'folders'
    | 'changes'
    | 'history'
    | 'log'
    | 'settings';

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
    /** The screens the current selection was made on, in the order they were first used. */
    selectedFrom: Page[];
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
    const [origins, setOrigins] = useState<Record<string, Page>>({});
    const [open, setOpen] = useState<ListableMessage | undefined>(undefined);

    // Read through a ref so the callbacks below do not have to change identity whenever the page
    // does; a new `toggleSelection` on every navigation would re-render every list in the app.
    const page = nav.page;
    const pageRef = useRef(page);
    pageRef.current = page;

    const toggleSelection = useCallback((message: ListableMessage) => {
        setSelected((current) =>
            current.some((entry) => entry.ID === message.ID)
                ? current.filter((entry) => entry.ID !== message.ID)
                : [...current, message]
        );
        setOrigins((current) => ({ ...current, [message.ID]: pageRef.current }));
    }, []);

    const selectMany = useCallback((messages: ListableMessage[]) => {
        setSelected((current) => {
            const known = new Set(current.map((entry) => entry.ID));
            return [...current, ...messages.filter((message) => !known.has(message.ID))];
        });
        setOrigins((current) => {
            const next = { ...current };
            for (const message of messages) {
                next[message.ID] ??= pageRef.current;
            }
            return next;
        });
    }, []);

    // Only the screens still represented by something selected. Deselecting the last mail from a
    // screen must drop that screen from the bar, or the bar keeps naming a place nothing came from.
    const selectedFrom = useMemo<Page[]>(() => {
        const seen: Page[] = [];
        for (const message of selected) {
            const origin = origins[message.ID];
            if (origin !== undefined && !seen.includes(origin)) {
                seen.push(origin);
            }
        }
        return seen;
    }, [selected, origins]);

    const value = useMemo<AppState>(
        () => ({
            nav,
            goTo: setNav,
            selected,
            selectedFrom,
            isSelected: (id) => selected.some((entry) => entry.ID === id),
            toggleSelection,
            selectMany,
            clearSelection: () => {
                setSelected([]);
                setOrigins({});
            },
            open,
            setOpen,
        }),
        [nav, selected, selectedFrom, open, toggleSelection, selectMany]
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
