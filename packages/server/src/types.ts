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
}

export interface MailboxSnapshot {
    meta: MailboxMeta;
    folders: MailboxFolder[];
    labels: MailboxFolder[];
    rules: MailboxRule[];
    unreadable: UnreadableRule[];
    messages: MailboxMessage[];
}

/**
 * The sync's shape, re-exported for the browser.
 *
 * The dashboard must not import `@pms/sync` — that package opens a database. This entry point
 * exists precisely so a type can cross that line without a value following it.
 */
export type { SyncProgressEvent, SyncState, SyncSummary } from './sync-channel.js';
