import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import {
    planCategoryMove,
    planChange,
    planRewind,
    planUndo,
    type ChangePlan,
    type PendingChange,
    type UndoableEntry,
} from '@pms/changes';
import { CATEGORY_LABELS, INBOX_LABEL } from '@pms/grouping';
import type { MailboxFolder, MailboxRule } from '@pms/server/types';

import { matchesRule } from '@pms/rules';

import { COMPARATOR_NAMES, FIELD_NAMES } from './rules/labels.js';
import { useMailbox } from './mailbox.js';

/**
 * The mutable half of the application: rules, folders, and the record of what was done to them.
 *
 * Every change goes the same way round, and the order is the product rather than an implementation
 * detail: **stage → diff → confirm → apply → verify → journal**. Nothing skips a step, including
 * the changes the tool itself proposes. A dialog that appears for a rule the user wrote by hand and
 * not for one the tool suggested would train them to click through it.
 *
 * The apply step calls `@pms/proton-api/write` — the only place allowed to change anything — and the
 * verification reads the messages back from Proton instead of trusting the plan. There is no local
 * apply beside it any more: it existed for the demo, and a second way for a change to take effect
 * is a second thing to keep in step with the first.
 */

export interface StoreState {
    rules: MailboxRule[];
    folders: MailboxFolder[];

    /** The change awaiting confirmation, with its consequences already computed. */
    staged: ChangePlan | undefined;
    /**
     * Offer a change for review.
     *
     * `resolves` names a drift entry the change answers. It is applied only once the change has
     * actually landed — see `settle`. Marking it on the click was wrong in the one direction that
     * matters: a change declined in the terminal left the entry crossed off anyway, so the screen
     * whose job is to report what really changed at Proton reported a decision nobody made.
     */
    stage: (change: PendingChange, resolves?: { id: string; decision: 'adopt' | 'reject' }) => void;
    /**
     * Stage a move of named messages into one of Proton's categories.
     *
     * Separate from `stage` because its plan comes from a different place. Every other change is
     * planned by simulating the rule set; this one is planned from the ids the user selected, and
     * routing it through `planChange` would produce a diff derived from rules that have nothing to
     * say about it — an empty one, most likely, for a change that moves mail.
     */
    stageCategoryMove: (categoryId: string, messageIds: string[]) => void;
    /**
     * Stage the taking-back of one recorded change.
     *
     * Planned from the journal's own snapshot rather than by simulating anything: it shows the
     * messages that actually moved, as observed after the write, and where each one individually
     * came from. A simulation would show what the change was expected to do — and an undo acting on
     * expectations would move a message back to somewhere it had never left.
     */
    stageUndo: (entry: UndoableEntry) => void;
    /**
     * Stage a rewind: everything from this entry onwards, newest first, in one go.
     *
     * One diff and one confirmation for the whole chain, because reversing four changes a dialog at
     * a time is where somebody stops reading them. The steps still run separately at Proton and are
     * journalled separately, so a rewind that stops halfway leaves a record that can be read.
     */
    stageRewind: (entries: readonly UndoableEntry[]) => void;
    discard: () => void;
    /**
     * The staged change reached the account.
     *
     * Called by the diff dialog when the write path reports success. It exists because the store
     * cannot see the HTTP round trip: the offer, the password question and the answer all happen in
     * `ApplyProvider`.
     */
    settle: () => void;

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

const Context = createContext<StoreState | undefined>(undefined);

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
    // Seeded from the mailbox. `App` remounts this provider when the copy underneath changes, so
    // there is no reseeding to write here: a finished sync or a landed write starts a fresh store
    // rather than carrying half-applied changes across two different pictures of the account.
    const { rules, folders, messages, categoryOfMessage } = useMailbox();
    const [staged, setStaged] = useState<ChangePlan | undefined>(undefined);
    /*
     * Drift, from the copy rather than from a fixture.
     *
     * A rule the sync found at Proton that this tool never wrote arrives unadopted, and that is what
     * lands here.
     */
    const [resolutions, setResolutions] = useState<Record<string, 'adopt' | 'reject'>>({});
    const drift = useMemo<DriftItem[]>(() => {
        return rules
            .filter((rule) => rule.adopted === false)
            .map((rule) =>
                withResolution(
                    {
                        id: rule.id,
                        kind: 'rule',
                        name: rule.name,
                        detail: describeRule(rule),
                        affected: messages.filter((message) => matchesRule(rule.rule, message)).length,
                    },
                    resolutions
                )
            );
    }, [rules, messages, resolutions]);

    const [pendingResolution, setPendingResolution] = useState<
        { id: string; decision: 'adopt' | 'reject' } | undefined
    >(undefined);

    const stage = useCallback(
        (change: PendingChange, resolves?: { id: string; decision: 'adopt' | 'reject' }) => {
            // The diff is computed before the dialog opens, so the dialog cannot show a change
            // whose consequences were never worked out.
            setStaged(planChange({ rules, messages, change }));
            setPendingResolution(resolves);
        },
        [rules, messages]
    );

    /** Whatever the landed change decided about a drift entry, recorded now that it is true. */
    const settle = useCallback(() => {
        setPendingResolution((pending) => {
            if (pending !== undefined) {
                setResolutions((current) => ({ ...current, [pending.id]: pending.decision }));
            }
            return undefined;
        });
    }, []);

    const stageCategoryMove = useCallback(
        (categoryId: string, messageIds: string[]) => {
            setPendingResolution(undefined);
            setStaged(
                planCategoryMove({
                    rules,
                    messages,
                    messageIds,
                    categoryId,
                    currentCategoryOf: categoryOfMessage,
                })
            );
        },
        [rules, messages, categoryOfMessage]
    );

    const stageUndo = useCallback(
        (entry: UndoableEntry) => {
            setPendingResolution(undefined);
            /*
             * Folders and Proton's categories, because a message moved into a category was in one
             * before and the undo has to be able to name it.
             *
             * The account's own *labels* are not here yet — the snapshot carries them and the
             * dashboard still discards them. An id none of these lists knows therefore comes
             * through unchanged rather than being hidden, so an unrecognised destination is
             * something to see before confirming instead of a blank afterwards.
             */
            const names = new Map<string, string>([
                ...folders.map((folder) => [folder.ID, folder.Name] as const),
                ...Object.entries(CATEGORY_LABELS),
                [INBOX_LABEL, 'Posteingang'],
            ]);
            setStaged(planUndo(entry, (labelId) => names.get(labelId)));
        },
        [folders]
    );

    const stageRewind = useCallback(
        (entries: readonly UndoableEntry[]) => {
            setPendingResolution(undefined);
            const names = new Map<string, string>([
                ...folders.map((folder) => [folder.ID, folder.Name] as const),
                ...Object.entries(CATEGORY_LABELS),
                [INBOX_LABEL, 'Posteingang'],
            ]);
            setStaged(planRewind(entries, (labelId) => names.get(labelId)));
        },
        [folders]
    );

    const resolveDrift = useCallback((id: string, decision: 'adopt' | 'reject') => {
        setResolutions((current) => ({ ...current, [id]: decision }));
    }, []);

    const value = useMemo<StoreState>(
        () => ({
            rules,
            folders,
            staged,
            stage,
            stageCategoryMove,
            stageUndo,
            stageRewind,
            discard: () => {
                setStaged(undefined);
                setPendingResolution(undefined);
            },
            settle,
            drift,
            resolveDrift,
        }),
        [
            rules,
            folders,
            staged,
            stage,
            stageCategoryMove,
            stageUndo,
            stageRewind,
            settle,
            drift,
            resolveDrift,
        ]
    );

    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useStore(): StoreState {
    const value = useContext(Context);
    if (value === undefined) {
        throw new Error('useStore outside StoreProvider');
    }
    return value;
}

/** Carry a user's decision onto a freshly derived item, since the list is recomputed, not stored. */
function withResolution(item: DriftItem, resolutions: Record<string, 'adopt' | 'reject'>): DriftItem {
    const resolved = resolutions[item.id];
    return resolved === undefined ? item : { ...item, resolved };
}

/**
 * One line saying what a rule does.
 *
 * Written from the same label maps the editor uses, so the sentence on this screen and the fields in
 * the editor cannot describe the same rule differently.
 */
function describeRule(rule: MailboxRule): string {
    const joiner = rule.rule.Operator.value === 'any' ? ' oder ' : ' und ';
    const conditions = rule.rule.Conditions.map((condition) => {
        const field = FIELD_NAMES[condition.Type.value] ?? condition.Type.value;
        const comparator = COMPARATOR_NAMES[condition.Comparator.value] ?? condition.Comparator.value;
        return condition.Values.length === 0
            ? `${field} ${comparator}`
            : `${field} ${comparator} „${condition.Values.join('" oder „')}"`;
    });

    const target = rule.rule.Actions.FileInto.at(-1);
    const destination = target === undefined || target === '' ? 'bleibt im Posteingang' : `→ nach „${target}"`;

    return conditions.length === 0
        ? `Ohne Bedingung, ${destination}`
        : `${conditions.join(joiner)} ${destination}`;
}
