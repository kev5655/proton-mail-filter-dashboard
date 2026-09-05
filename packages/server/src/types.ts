import type { SimpleObject } from '@proton/sieve/filterModel';

/**
 * What the dashboard receives from the local server.
 *
 * Its own module, with nothing but types in it, because the browser imports this file and must not
 * end up importing anything that opens a database. `@pms/server/types` is a separate entry point
 * from `@pms/server` for that reason: a value import from the wrong one is a build error rather
 * than a bundle that fails at runtime.
 *
 * The shapes are Proton's, not the database's. The dashboard already speaks them — the demo
 * mailbox is written in them too — so the same screens render either source without knowing which
 * one they are looking at. That is the point of the exercise: if the real mailbox needed different
 * components, the demo would have stopped being a test of anything.
 */

export interface MailboxMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string; Name: string };
    ToList: Array<{ Address: string }>;
    Time: number;
    LabelIDs: string[];
    Unread: number;
    NumAttachments: number;
    /**
     * Proton's conversation, when it gave one.
     *
     * Only for building a link into their web interface — the mailbox there shows conversations,
     * not messages. Nothing matches on it.
     */
    ConversationID?: string | undefined;
}

export interface MailboxFolder {
    ID: string;
    Name: string;
    ParentID: string | null;
    /** Set when the folder duplicates one of Proton's own — usually an IMAP migration leftover. */
    shadowsSystemFolder?: string;
}

export interface MailboxRule {
    id: string;
    name: string;
    priority: number;
    enabled: boolean;
    /** Sieve-authored rules cannot be edited in Proton's own interface any more. */
    authoredAs: 'tree' | 'sieve';
    /**
     * False for a rule that turned up at Proton without this tool doing it.
     *
     * The first sync adopts everything the account already had — that is the starting position, not
     * a surprise. Afterwards a rule written in Proton's own interface arrives unadopted, and the
     * „Änderungen" screen asks about it before it counts as part of the set. Without this the rule
     * simply appeared among the others, as though it had always been there.
     *
     * Optional because the demo mailbox has no Proton to drift from; absent means adopted.
     */
    adopted?: boolean;
    rule: SimpleObject;
}

/**
 * A filter that is in the account but could not be read as a rule.
 *
 * Kept and reported rather than dropped. A filter the tool cannot parse still runs at Proton and
 * still moves mail, so a screen that silently omits it would be showing a mailbox that does not
 * exist — and every conflict analysis built on that list would be wrong in the user's favour.
 */
export interface UnreadableRule {
    id: string;
    name: string;
    reason: string;
}

export interface MailboxMeta {
    /** `demo` never reaches the wire; it is what the dashboard uses when no server answers. */
    source: 'proton';
    /** Unix seconds of the last completed sync, or undefined if none has finished. */
    syncedAt: number | undefined;
    /** Messages in the local copy, which is not the same as messages in the account. */
    messageCount: number;
    /** True when the last sync stopped at its limit, so the copy is known to be partial. */
    truncated: boolean;
    /**
     * What the account looked like when this copy was made.
     *
     * Sent back with any change the dashboard offers, so a write can be refused when the account
     * has moved since — the diff the user approved would then describe a mailbox that no longer
     * exists.
     */
    version: string;
    /**
     * How many changes the record keeps.
     *
     * Sent rather than restated in the browser, because it is the journal's number and two copies
     * of one number drift. The screen says it out loud so „meine ältesten Änderungen sind weg"
     * has an answer that is on the screen rather than in a source file.
     */
    historyLimit: number;
}

/**
 * Proton's category history, as the dashboard receives it.
 *
 * Types only, structurally identical to `@pms/grouping`'s. Restated rather than re-exported because
 * this file is the browser's contract and must stay free of value imports — and `@pms/grouping` is
 * a value module. `deriveAutoRules` accepts these because the shapes match.
 */
export interface CategoryObservationDto {
    senderAddress: string;
    senderDomain: string;
    categoryId: string;
    /** Unix seconds of the sync that saw this — when we *looked*, not when the mail arrived. */
    observedAt: number;
    messageCount: number;
}

export interface CategoryChangeDto {
    messageId: string;
    senderAddress: string;
    /** Absent when the message had no category before: a first sighting, not a change of mind. */
    fromCategory: string | undefined;
    toCategory: string;
    observedAt: number;
}

export interface MailboxSnapshot {
    meta: MailboxMeta;
    folders: MailboxFolder[];
    labels: MailboxFolder[];
    rules: MailboxRule[];
    unreadable: UnreadableRule[];
    messages: MailboxMessage[];
    /**
     * What Proton's own sorting did, over the syncs we have.
     *
     * Empty on a copy made before the history existed, and near-empty on a young one. That is not a
     * gap to paper over: it is the honest state, and the screen says "not enough looks yet" rather
     * than inventing a verdict from a single snapshot.
     */
    categoryObservations: CategoryObservationDto[];
    categoryChanges: CategoryChangeDto[];
    /**
     * What this tool changed at the account, newest first.
     *
     * Read from the local database rather than held in the browser, which is where it used to live
     * — and why it was empty against every real mailbox: the entry was built correctly by the write
     * path and then dropped, so „Verlauf" only ever filled up in the demo.
     *
     * `moved` carries message ids and label ids and nothing else. The diff had subjects and senders
     * and did not need to keep them.
     */
    history: JournalEntryDto[];
}

/** One applied change, as the dashboard reads it back. */
export interface JournalEntryDto {
    id: string;
    /** Unix **seconds**, when the change was applied. */
    atSeconds: number;
    kind: string;
    /** The wording as it stood when the change was made. */
    summary: string;
    /** The messages this change moved, and where each one was before. */
    moved: Array<{ messageId: string; previousLabelIds: string[]; movedTo: string | undefined }>;
    /** What the check afterwards saw. Absent when nothing was expected to move. */
    verification?: { confirmed: number; stragglers: number; checkedAtSeconds: number } | undefined;
    /** The full backup taken before the write. */
    backupPath: string;
    /** Unix **seconds**, set once this entry has been taken back. */
    undoneAtSeconds?: number | undefined;
    /** Set when this entry is itself an undo, naming what it took back. */
    undoesId?: string | undefined;
}

/**
 * The sync's shape, re-exported for the browser.
 *
 * The dashboard must not import `@pms/sync` — that package opens a database. This entry point
 * exists precisely so a type can cross that line without a value following it.
 */
export type { SyncProgressEvent, SyncState, SyncSummary } from './sync-channel.js';
