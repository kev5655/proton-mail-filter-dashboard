import type { SimpleObject } from '@proton/sieve/filterModel';
import { CATEGORY_LABELS } from '@pms/grouping';
import { resolveOutcome, type MatchableMessage, type OrderedRule } from '@pms/rules';

/**
 * Working out what a change would actually do, before it is made.
 *
 * The dashboard's promise is that nothing reaches Proton unexamined, and this is what makes that
 * promise mean something. A rule shown as "sender contains X → Archiv" tells the user what the rule
 * says; only simulating the whole rule set against the indexed mail tells them what it *does*.
 *
 * The two are different more often than one would like. Adding a rule can move mail that another
 * rule was quietly handling; deleting one can hand its mail to a catch-all further down. Both are
 * invisible from the rule text and obvious from the diff.
 */

export type ChangeKind =
    | 'create-rule'
    | 'update-rule'
    | 'delete-rule'
    | 'enable-rule'
    | 'disable-rule'
    | 'create-folder'
    | 'rename-folder'
    | 'delete-folder'
    /**
     * Taking responsibility for a rule that appeared at Proton on its own.
     *
     * The only kind that writes nothing to the account. It travels the same route as every other
     * change — offered, planned, recorded — because the decision it records is a real one: from
     * here on the tool treats that rule as part of the set it manages, and the diff shows what the
     * rule already does before anyone agrees to that.
     */
    | 'adopt-rule'
    /**
     * Moving named messages into one of Proton's categories.
     *
     * The second of the two changes that move mail, and the only one a person initiates. It exists
     * because a category is not a folder: no filter can file into one, and Proton's own client
     * moves the mail and lets the server draw its own conclusion about the sender. Doing it from
     * here is the only way to reach that mechanism at all.
     *
     * It names message ids and nothing else — never a sender, never a folder, never "the rest of
     * these". The diff lists them, the terminal asks about them, and exactly those move.
     */
    | 'move-to-category'
    /**
     * Taking one recorded change back — the rule *and* the mail it moved.
     *
     * It names a journal entry and nothing else. Everything about what will happen comes from that
     * entry's own record: the inverse change puts the rules back, and the per-message snapshot puts
     * each message where *it* was, which is not necessarily where any of the others were. A
     * description of the change could not do that, which is why the snapshot exists.
     */
    | 'undo-entry'
    /**
     * Taking back everything from one point onwards, newest first.
     *
     * A chain of undos with one diff and one confirmation, because reversing four changes one
     * dialog at a time is where somebody stops reading. It names the oldest entry to reverse; the
     * rest is read from the record.
     *
     * It stops at the first failure rather than continuing. A partly-rewound account is a state
     * somebody has to be able to look at and understand, and pressing on past an error would make
     * it one nobody could describe.
     */
    | 'rewind-to';

export interface PendingChange {
    id: string;
    kind: ChangeKind;
    /*
     * There is deliberately no `summary` here.
     *
     * There was, and it was written by hand at ten call sites — which produced two wordings for the
     * same act depending on which screen staged it, and „Regel „X" ändern" for an edit that moved
     * mail to a different folder. The history then inherited whichever phrasing happened to be
     * used. A change is named in three places that have to agree — the diff, the terminal question
     * and the history — so the name is derived from the change itself, by `describeChange`, and
     * there is no field to get out of step.
     */
    /** For rule changes: the rule as it is now, absent when creating. */
    before?: OrderedRule | undefined;
    /** For rule changes: the rule as it would be, absent when deleting. */
    after?: OrderedRule | undefined;
    /** For folder changes. */
    folder?: { name: string; newName?: string; parent?: string | undefined } | undefined;
    /**
     * For a category move: where, and exactly which messages.
     *
     * The ids are the whole authorisation. Nothing downstream widens them, and nothing derives them
     * from a sender or a folder — that is what keeps this narrow enough to be an exception.
     */
    category?: { id: string; messageIds: string[] } | undefined;
    /** For an undo: which recorded change is being taken back. */
    undo?: { entryId: string } | undefined;
}

/** One message whose destination the change alters. */
export interface Move {
    messageId: string;
    subject: string;
    sender: string;
    /** Where it goes today. `undefined` means it stays in the inbox. */
    from: string | undefined;
    /** Where it would go afterwards. */
    to: string | undefined;
}

export interface ChangePlan {
    change: PendingChange;
    /** Every message whose destination differs before and after. */
    moves: Move[];
    /** Messages that would leave the inbox — the point of the exercise. */
    clearedFromInbox: number;
    /** Messages that would come *back* to the inbox, which is usually a surprise. */
    returnedToInbox: number;
    /**
     * Messages a different rule was handling and this change takes over, with that rule's name.
     * Not an error, but the thing most likely to be unintended.
     */
    takenFrom: Array<{ ruleName: string; count: number }>;
}

export interface PlanInput {
    rules: OrderedRule[];
    messages: Array<MatchableMessage & { ID: string; Subject: string; Sender: { Address: string } }>;
    change: PendingChange;
}

/**
 * Apply a pending change to a rule set without touching the original.
 *
 * Exported because the diff, the verification and the undo journal all need the same "what would
 * the world look like" calculation, and three implementations of it would drift.
 */
export function applyChangeToRules(rules: OrderedRule[], change: PendingChange): OrderedRule[] {
    switch (change.kind) {
        case 'create-rule':
            return change.after === undefined ? rules : [...rules, change.after];

        case 'update-rule':
            return change.after === undefined
                ? rules
                : rules.map((rule) => (rule.id === change.after?.id ? change.after : rule));

        case 'delete-rule':
            return rules.filter((rule) => rule.id !== change.before?.id);

        case 'enable-rule':
        case 'disable-rule':
            return rules.map((rule) =>
                rule.id === change.before?.id ? { ...rule, enabled: change.kind === 'enable-rule' } : rule
            );

        // Adopting changes who is responsible for a rule, not what it does.
        case 'adopt-rule':
            return rules;

        // Moving mail into a category changes where some mail is, not which rule matches what.
        // Proton may draw a conclusion from it, but that conclusion is not a rule we hold.
        case 'move-to-category':
            return rules;

        /*
         * An undo does change the rules, and this function cannot say how.
         *
         * The change it reverses is in the journal, not in this object — deliberately, so that the
         * dashboard can offer an undo without carrying a copy of the original around. The rule set
         * is put back by applying the *recorded inverse* through the ordinary write path, which is
         * a step later and in a place that can read the record.
         */
        case 'undo-entry':
        case 'rewind-to':
            return rules;

        // Folder changes do not alter which rule matches what, only where the mail is put. A rename
        // is the exception, and it is handled by rewriting the rules that point at the old name.
        case 'rename-folder':
            return change.folder === undefined || change.folder.newName === undefined
                ? rules
                : rules.map((rule) => renameTarget(rule, change.folder?.name ?? '', change.folder?.newName ?? ''));

        default:
            return rules;
    }
}

function renameTarget(rule: OrderedRule, from: string, to: string): OrderedRule {
    const rewrite = (target: string): string =>
        target === from ? to : target.endsWith(`/${from}`) ? `${target.slice(0, -from.length)}${to}` : target;

    const fileInto = rule.rule.Actions.FileInto.map(rewrite);
    if (fileInto.every((target, index) => target === rule.rule.Actions.FileInto[index])) {
        return rule;
    }

    const updated: SimpleObject = {
        ...rule.rule,
        Actions: { ...rule.rule.Actions, FileInto: fileInto },
    };
    return { ...rule, rule: updated };
}

export function planChange({ rules, messages, change }: PlanInput): ChangePlan {
    const after = applyChangeToRules(rules, change);

    const moves: Move[] = [];
    const takenFrom = new Map<string, number>();

    for (const message of messages) {
        const before = resolveOutcome(rules, message);
        const now = resolveOutcome(after, message);

        if (before.destination === now.destination) {
            continue;
        }

        moves.push({
            messageId: message.ID,
            subject: message.Subject,
            sender: message.Sender.Address,
            from: before.destination,
            to: now.destination,
        });

        // Which rule used to decide this message, if any. Knowing that a new rule is taking mail
        // away from an existing one is the difference between a tidy-up and a surprise.
        const previousOwner = before.matching.filter((entry) => filesInto(entry)).at(-1);
        if (previousOwner !== undefined && previousOwner.id !== change.after?.id) {
            takenFrom.set(previousOwner.name, (takenFrom.get(previousOwner.name) ?? 0) + 1);
        }
    }

    return {
        change,
        moves,
        clearedFromInbox: moves.filter((move) => move.from === undefined && move.to !== undefined).length,
        returnedToInbox: moves.filter((move) => move.from !== undefined && move.to === undefined).length,
        takenFrom: [...takenFrom].map(([ruleName, count]) => ({ ruleName, count })).sort((a, b) => b.count - a.count),
    };
}

function filesInto(rule: OrderedRule): boolean {
    const target = rule.rule.Actions.FileInto.at(-1);
    return target !== undefined && target !== '';
}

/** A short, honest sentence about the consequences, for the confirmation button's neighbourhood. */
export function describePlan(plan: ChangePlan): string {
    if (plan.moves.length === 0) {
        return 'Diese Änderung verschiebt keine der erfassten Mails.';
    }

    const parts = [`${plan.moves.length} Mails würden anders einsortiert`];
    if (plan.clearedFromInbox > 0) {
        parts.push(`${plan.clearedFromInbox} verlassen den Posteingang`);
    }
    if (plan.returnedToInbox > 0) {
        parts.push(`${plan.returnedToInbox} kommen in den Posteingang zurück`);
    }
    return `${parts.join(', ')}.`;
}

export interface CategoryMoveInput {
    /** The rules as they stand, so the diff can say which one is already handling this mail. */
    rules: OrderedRule[];
    messages: PlanInput['messages'];
    /** The messages the user picked, by id. Nothing else moves. */
    messageIds: string[];
    categoryId: string;
    /** Which of Proton's categories each message carries today, by message id. */
    currentCategoryOf: (messageId: string) => string | undefined;
}

/**
 * The plan for a category move.
 *
 * A separate builder rather than a branch inside `planChange`, because the two derive their moves
 * from opposite things. `planChange` simulates the rule set and reads the moves out of the
 * difference; here the moves *are* the input — the user named them — and simulating anything would
 * be inventing a second opinion about a decision that has already been made.
 *
 * Three things it deliberately does not claim:
 *
 *  - **`clearedFromInbox` stays 0.** Whether a category takes mail out of the inbox is not
 *    established. Proton's own client sends one request and no `unlabel`, which hints that the
 *    previous category falls away, and hints at nothing about the inbox. The first real run settles
 *    it; a number here would be a guess dressed as a count.
 *  - **A message already in the target category still appears as a move**, with `from` and `to`
 *    equal. Dropping it would quietly shrink the list the user is asked to approve below the list
 *    they selected, and the count in the terminal would stop matching the count on the screen.
 *  - **`takenFrom` is the duplicate warning again**, in the last place before a write: a rule of the
 *    user's own is already filing this mail somewhere, and moving it into a category may well be
 *    doing the same work twice.
 */
export function planCategoryMove(input: CategoryMoveInput): ChangePlan {
    const wanted = new Set(input.messageIds);
    const to = CATEGORY_LABELS[input.categoryId] ?? `Kategorie ${input.categoryId}`;

    const change: PendingChange = {
        id: `cat-${input.categoryId}-${String(input.messageIds.length)}`,
        kind: 'move-to-category',
        category: { id: input.categoryId, messageIds: [...input.messageIds] },
    };

    const moves: Move[] = [];
    const takenFrom = new Map<string, number>();

    for (const message of input.messages) {
        if (!wanted.has(message.ID)) {
            continue;
        }

        const currentId = input.currentCategoryOf(message.ID);
        moves.push({
            messageId: message.ID,
            subject: message.Subject,
            sender: message.Sender.Address,
            from: currentId === undefined ? undefined : (CATEGORY_LABELS[currentId] ?? `Kategorie ${currentId}`),
            to,
        });

        const owner = resolveOutcome(input.rules, message).matching.filter((entry) => filesInto(entry)).at(-1);
        if (owner !== undefined) {
            takenFrom.set(owner.name, (takenFrom.get(owner.name) ?? 0) + 1);
        }
    }

    return {
        change,
        moves,
        clearedFromInbox: 0,
        returnedToInbox: 0,
        takenFrom: [...takenFrom].map(([ruleName, count]) => ({ ruleName, count })).sort((a, b) => b.count - a.count),
    };
}

/** What a recorded change did, as much of it as an undo needs to describe itself. */
export interface UndoableEntry {
    id: string;
    summary: string;
    moved: Array<{ messageId: string; previousLabelIds: string[]; movedTo: string | undefined }>;
}

/**
 * The plan for taking one recorded change back.
 *
 * Built from the journal's snapshot rather than by simulating anything, and that is the whole
 * point: it shows the messages that *actually* moved, as observed after the write, and where each
 * one individually came from. A simulation would show what the change was expected to do, which is
 * the thing an undo must not act on — a message that never moved would be "moved back" to somewhere
 * it had never left.
 *
 * `resolveLabel` turns the recorded label ids into names, because the snapshot speaks Proton's ids
 * and a person reads folder names. An id it cannot place comes back as-is rather than being hidden:
 * an unrecognised destination is a thing to see before confirming, not after.
 */
export function planUndo(
    entry: UndoableEntry,
    resolveLabel: (labelId: string) => string | undefined
): ChangePlan {
    const change: PendingChange = {
        id: `undo-${entry.id}`,
        kind: 'undo-entry',
        undo: { entryId: entry.id },
    };

    const moves: Move[] = entry.moved.map((moved) => ({
        messageId: moved.messageId,
        // The journal keeps no subjects or senders — it did not need them and what is not stored
        // cannot leak. The id is what the row can honestly show.
        subject: moved.messageId,
        sender: '',
        from: moved.movedTo,
        to: previousName(moved.previousLabelIds, resolveLabel),
    }));

    return {
        change,
        moves,
        clearedFromInbox: 0,
        returnedToInbox: moves.filter((move) => move.to === undefined).length,
        takenFrom: [],
    };
}

/**
 * Where one message was before, by the same rule the undo itself will follow.
 *
 * A folder first, then whatever else can be named, then the inbox — the order of specificity. A
 * message moved into a category was in the inbox *and* in another category beforehand, and undoing
 * it to the inbox would silently drop the thing being restored.
 */
function previousName(
    previousLabelIds: readonly string[],
    resolveLabel: (labelId: string) => string | undefined
): string | undefined {
    for (const labelId of previousLabelIds) {
        const name = resolveLabel(labelId);
        if (name !== undefined) {
            return name;
        }
    }
    return undefined;
}

/**
 * The plan for taking back everything from one point onwards.
 *
 * The entries arrive newest first, which is also the order they will be reversed in: undoing an
 * older change before a newer one that was built on top of it would put the account through a state
 * nobody planned.
 *
 * The moves are every entry's moves together, and a message that two changes both touched appears
 * once, restored to where the *oldest* of them found it — which is what walking backwards actually
 * produces. Computing it any other way would show a diff that the run then contradicts.
 */
export function planRewind(
    entries: readonly UndoableEntry[],
    resolveLabel: (labelId: string) => string | undefined
): ChangePlan {
    const oldest = entries.at(-1);
    const change: PendingChange = {
        id: `rewind-${oldest?.id ?? 'nothing'}`,
        kind: 'rewind-to',
        undo: { entryId: oldest?.id ?? '' },
    };

    // Newest first in, so a later assignment is by an older entry — the one whose "before" is the
    // state a full rewind lands on.
    const byMessage = new Map<string, Move>();
    for (const entry of entries) {
        for (const moved of entry.moved) {
            byMessage.set(moved.messageId, {
                messageId: moved.messageId,
                subject: moved.messageId,
                sender: '',
                from: moved.movedTo,
                to: previousName(moved.previousLabelIds, resolveLabel),
            });
        }
    }

    const moves = [...byMessage.values()];
    return {
        change,
        moves,
        clearedFromInbox: 0,
        returnedToInbox: moves.filter((move) => move.to === undefined).length,
        takenFrom: [],
    };
}
