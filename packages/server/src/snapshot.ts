import { describeChange } from '@pms/changes';
import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';
import {
    getMeta,
    JOURNAL_LIMIT,
    readCategoryChanges,
    readCategoryObservations,
    readFilters,
    readFolderTree,
    readJournal,
    readMessages,
    type StoredFolder,
} from '@pms/sync';
import { fromSieveTree } from '@proton/sieve/fromSieveTree';
import type { SimpleObject } from '@proton/sieve/filterModel';

import type {
    MailboxFolder,
    MailboxMessage,
    MailboxRule,
    MailboxSnapshot,
    UnreadableRule,
} from './types.js';

const log = getLogger('server');

/**
 * Turn the local copy into what the dashboard renders.
 *
 * Everything here reads. There is no code path in this package that writes to the database, let
 * alone to Proton — the dashboard is a reader of a mirror, and the mirror is filled by `pnpm sync`.
 *
 * The translation is small on purpose. The database keeps Proton's own shapes, and the dashboard
 * speaks Proton's own shapes, so this is mostly renaming plus two decisions that need saying:
 * which filters could not be read, and which folders shadow one of Proton's.
 */

/** Reading messages in one query, capped. Above this the screens stop being usable anyway. */
const MESSAGE_LIMIT = 5_000;

export function buildSnapshot(db: Db, limit = MESSAGE_LIMIT): MailboxSnapshot {
    const folders = flatten(readFolderTree(db, 3));
    const labels = flatten(readFolderTree(db, 1));

    const rules: MailboxRule[] = [];
    const unreadable: UnreadableRule[] = [];

    for (const filter of readFilters(db)) {
        const simple = toSimple(filter.simple, filter.tree);
        if (simple === undefined) {
            // Reported rather than dropped: it still runs at Proton. See `UnreadableRule`.
            unreadable.push({
                id: filter.id,
                name: filter.name,
                reason:
                    filter.tree === undefined
                        ? 'Proton hat weder Simple- noch Tree-Form geliefert.'
                        : 'Die Tree-Form liess sich nicht in das Regelmodell übersetzen.',
            });
            continue;
        }
        rules.push({
            id: filter.id,
            name: filter.name,
            priority: filter.priority,
            enabled: filter.enabled,
            authoredAs: filter.authoredAs,
            adopted: filter.adopted,
            rule: simple,
        });
    }

    if (unreadable.length > 0) {
        log.warn({ count: unreadable.length }, 'filters that could not be read as rules');
    }

    const messages: MailboxMessage[] = readMessages(db, { limit }).map((message) => ({
        ID: message.id,
        Subject: message.subject,
        Sender: { Address: message.sender.address, Name: message.sender.name },
        // Stored all along, in the `recipients` table, and never read back until now — which is
        // why a rule filtering on the recipient matched nothing here while working at Proton.
        ToList: message.recipients.map((address) => ({ Address: address })),
        Time: message.time,
        LabelIDs: message.labelIds,
        Unread: message.unread ? 1 : 0,
        NumAttachments: message.numAttachments,
        ...(message.conversationId === undefined ? {} : { ConversationID: message.conversationId }),
    }));

    const syncedAt = Number(getMeta(db, 'lastSyncAt') ?? NaN);

    return {
        meta: {
            source: 'proton',
            syncedAt: Number.isFinite(syncedAt) ? syncedAt : undefined,
            messageCount: messages.length,
            truncated: getMeta(db, 'lastSyncTruncated') === '1',
            version: getMeta(db, 'accountVersion') ?? '',
            historyLimit: JOURNAL_LIMIT,
        },
        folders,
        labels,
        rules,
        unreadable,
        messages,
        categoryObservations: readCategoryObservations(db),
        categoryChanges: readCategoryChanges(db),
        /*
         * The record of what was changed, travelling in the snapshot rather than on a route of its
         * own. It is read-only data about this mailbox, exactly like the rest of it.
         *
         * Mapped rather than passed through: `stragglers` becomes a count. The ids are in the
         * database for undo to work from and have no business in a browser tab, where they would
         * end up in a copied bug report.
         */
        history: readJournal(db).map((entry) => ({
            id: entry.id,
            atSeconds: entry.atSeconds,
            kind: entry.change.kind,
            summary: describeChange(entry.change),
            moved: entry.moved,
            ...(entry.verification === undefined
                ? {}
                : {
                      verification: {
                          confirmed: entry.verification.confirmed,
                          stragglers: entry.verification.stragglers.length,
                          checkedAtSeconds: entry.verification.checkedAtSeconds,
                      },
                  }),
            backupPath: entry.backupPath,
            ...(entry.undoneAtSeconds === undefined ? {} : { undoneAtSeconds: entry.undoneAtSeconds }),
            ...(entry.undoesId === undefined ? {} : { undoesId: entry.undoesId }),
        })),
    };
}

/**
 * The rule model, from whichever form Proton stored.
 *
 * `Simple` when it is there, otherwise the tree — a Sieve-authored filter has no `Simple` at all,
 * which `real-filter.test.ts` established against a genuine one. Returning undefined rather than
 * throwing keeps one unreadable filter from hiding the whole mailbox.
 */
function toSimple(simple: unknown, tree: unknown): SimpleObject | undefined {
    if (simple !== undefined && simple !== null) {
        return simple as SimpleObject;
    }
    if (tree === undefined || tree === null) {
        return undefined;
    }
    try {
        const parsed = fromSieveTree(tree);
        return parsed === null ? undefined : parsed;
    } catch (cause) {
        log.debug({ cause }, 'a filter tree did not parse');
        return undefined;
    }
}

/**
 * The folder tree as a flat list with parent ids.
 *
 * The tree was built for screens that draw one; this shape is what the rule engine and the demo
 * both use. Depth is recoverable from the parents, so nothing is lost.
 */
function flatten(roots: readonly StoredFolder[]): MailboxFolder[] {
    const out: MailboxFolder[] = [];
    const walk = (folder: StoredFolder): void => {
        const shadowed = SYSTEM_FOLDER_NAMES.get(folder.name.trim().toLowerCase());
        out.push({
            ID: folder.id,
            Name: folder.name,
            ParentID: folder.parentId ?? null,
            ...(shadowed === undefined ? {} : { shadowsSystemFolder: shadowed }),
        });
        for (const child of folder.children) {
            walk(child);
        }
    };
    for (const root of roots) {
        walk(root);
    }
    return out;
}

/**
 * Folder names that duplicate one Proton already has.
 *
 * Almost always left over from an IMAP migration, and worth flagging because a rule filing into
 * "Junk" puts mail somewhere the user never looks while Proton's own Spam folder sits next to it.
 * Names only — Proton's system folders have fixed ids, but a migrated duplicate is an ordinary
 * folder with an ordinary id, so the name is the only thing the two have in common.
 */
const SYSTEM_FOLDER_NAMES = new Map<string, string>([
    ['deleted items', 'Papierkorb'],
    ['deleted messages', 'Papierkorb'],
    ['trash', 'Papierkorb'],
    ['junk', 'Spam'],
    ['junk e-mail', 'Spam'],
    ['spam', 'Spam'],
    ['sent', 'Gesendet'],
    ['sent items', 'Gesendet'],
    ['sent messages', 'Gesendet'],
    ['drafts', 'Entwürfe'],
    ['entwürfe', 'Entwürfe'],
    ['archive', 'Archiv'],
]);
