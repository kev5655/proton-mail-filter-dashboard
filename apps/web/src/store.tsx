import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import {
    Journal,
    applyChangeToRules,
    planChange,
    verifyMoves,
    type ChangePlan,
    type JournalEntry,
    type PendingChange,
} from '@pms/changes';
import type { MailboxFolder, MailboxRule } from '@pms/server/types';

import { useMailbox, useMailboxStatus } from './mailbox.js';

/**
 * The mutable half of the application: rules, folders, and the record of what was done to them.
 *
 * Every change goes the same way round, and the order is the product rather than an implementation
 * detail: **stage → diff → confirm → apply → verify → journal**. Nothing skips a step, including
 * the changes the tool itself proposes. A dialog that appears for a rule the user wrote by hand and
 * not for one the tool suggested would train them to click through it.
 *
 * In the demo the apply step is local. In the real thing it calls `@pms/proton-api/write`, which is
 * the only place allowed to change anything, and the verification reads the messages back from
 * Proton instead of trusting the plan.
 */

export interface StoreState {
    rules: MailboxRule[];
    folders: MailboxFolder[];
    journal: readonly JournalEntry[];

    /** The change awaiting confirmation, with its consequences already computed. */
    staged: ChangePlan | undefined;
    stage: (change: PendingChange) => void;
    discard: () => void;
    /** Apply the staged change. Only reachable from the diff dialog. */
    confirm: () => void;

    undo: (entryId: string) => void;
    /** Rules and folders that appeared at Proton without the tool doing it. */
    drift: DriftItem[];
    resolveDrift: (id: string, decision: 'adopt' | 'reject') => void;
}

export interface DriftItem {
    id: string;
    kind: 'rule' | 'folder';
    name: string;
    /** What it does, in one line. */
    detail: string;
    /** Messages it affects, so adopting or rejecting is an informed decision. */
    affected: number;
    resolved?: 'adopt' | 'reject';
}

/**
 * Changes made in Proton's own interface since the tool last looked.
 *
 * Fixed here because the demo has no Proton to sync with; in the real thing the sync engine
 * produces this list by diffing the filters and folders it knows about against what the API
 * returns.
 *
 * Shown for the demo only. Against a real account these two invented items appeared on the one
 * screen whose entire job is to report what actually changed at Proton — a screen about honesty,
 * furnished with fiction.
 */
const INITIAL_DRIFT: DriftItem[] = [
    {
        id: 'd-1',
        kind: 'rule',
        name: 'Zahnarzt',
        detail: 'Absender enthält „praxis@zahnarzt.example" → nach „Wichtig"',
        affected: 1,
    },
    {
        id: 'd-2',
        kind: 'folder',
        name: 'Steuern 2026',
        detail: 'Neuer Ordner auf oberster Ebene, bisher ohne Regel',
        affected: 0,
    },
];

const Context = createContext<StoreState | undefined>(undefined);

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    // Seeded from whichever mailbox is in play. `App` remounts this provider when the source
    // changes, so there is no reseeding to write here: switching from the demo to the real account
    // starts a fresh store rather than carrying half-applied changes across two different mailboxes.
    const { rules: initialRules, folders: initialFolders, messages } = useMailbox();
    const { source } = useMailboxStatus();
    const [rules, setRules] = useState<MailboxRule[]>(initialRules);
    const [folders, setFolders] = useState<MailboxFolder[]>(initialFolders);
    const [staged, setStaged] = useState<ChangePlan | undefined>(undefined);
    const [drift, setDrift] = useState<DriftItem[]>(source === 'demo' ? INITIAL_DRIFT : []);
    const [journal] = useState(() => new Journal());
    const [version, setVersion] = useState(0);

    const stage = useCallback(
        (change: PendingChange) => {
            // The diff is computed before the dialog opens, so the dialog cannot show a change
            // whose consequences were never worked out.
            setStaged(planChange({ rules, messages, change }));
        },
        [rules]
    );

    const confirm = useCallback(() => {
        if (staged === undefined) {
            return;
        }

        const now = Date.now();
        const next = applyChangeToRules(rules, staged.change) as MailboxRule[];
        setRules(next);
        applyFolderChange(staged.change, setFolders);

        const entry = journal.record({
            id: `j-${now}`,
            at: now,
            change: staged.change,
            moved: staged.moves.map((move) => ({
                messageId: move.messageId,
                // In the real thing these come from the message as it was before the write.
                previousLabelIds: move.from === undefined ? ['0'] : [move.from],
                movedTo: move.to,
            })),
        });

        // Stands in for reading the messages back from Proton. The demo has nothing to read from,
        // so it confirms what the plan predicted — the shape is what matters here, and the real
        // implementation swaps `actual` for the API response without touching anything else.
        journal.attachVerification(
            entry.id,
            verifyMoves({
                expected: staged.moves,
                actual: staged.moves.map((move) => ({
                    ID: move.messageId,
                    LabelIDs: [move.to ?? '0'],
                })),
                folderIds: new Map(staged.moves.map((move) => [move.to ?? '', move.to ?? '0'])),
                now,
            })
        );

        setStaged(undefined);
        setVersion((current) => current + 1);
    }, [staged, rules, journal]);

    const undo = useCallback(
        (entryId: string) => {
            const result = journal.undo(entryId, rules, Date.now());
            setRules(result.rules as MailboxRule[]);
            setVersion((current) => current + 1);
        },
        [journal, rules]
    );

    const resolveDrift = useCallback((id: string, decision: 'adopt' | 'reject') => {
        setDrift((current) =>
            current.map((item) => (item.id === id ? { ...item, resolved: decision } : item))
        );
    }, []);

    const value = useMemo<StoreState>(
        () => ({
            rules,
            folders,
            journal: journal.entries,
            staged,
            stage,
            discard: () => setStaged(undefined),
            confirm,
            undo,
            drift,
            resolveDrift,
        }),
        // `version` is in the list because the journal is mutable and does not change identity.
        [rules, folders, journal, staged, stage, confirm, undo, drift, resolveDrift, version]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

function applyFolderChange(
    change: PendingChange,
    setFolders: React.Dispatch<React.SetStateAction<MailboxFolder[]>>
): void {
    if (change.folder === undefined) {
        return;
    }
    const folder = change.folder;

    switch (change.kind) {
        case 'create-folder':
            setFolders((current) => [
                ...current,
                { ID: `f-${Date.now()}`, Name: folder.name, ParentID: folder.parent ?? null },
            ]);
            break;
        case 'rename-folder':
            setFolders((current) =>
                current.map((entry) =>
                    entry.Name === folder.name ? { ...entry, Name: folder.newName ?? entry.Name } : entry
                )
            );
            break;
        case 'delete-folder':
            setFolders((current) => current.filter((entry) => entry.Name !== folder.name));
            break;
        default:
            break;
    }
}

export function useStore(): StoreState {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useStore outside StoreProvider');
    }
    return value;
}
