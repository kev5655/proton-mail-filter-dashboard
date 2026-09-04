import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { ProtonHttp } from '@pms/proton-api';
import { moveMessagesBack } from '@pms/proton-api/write/messages';

import type { JournalEntry, MovedMessage } from './journal.js';

const log = getLogger('undo');

/**
 * Undoing a change, including the mail it moved.
 *
 * This is the single documented exception to the rule that this tool never moves mail, and it is
 * narrow on purpose. It is also the only importer of `@pms/proton-api/write/messages` anywhere in
 * the project — `write-isolation.test.ts` enforces that, and the module is deliberately absent from
 * the write barrel so nothing can reach it by accident.
 *
 * Two constraints define the whole design:
 *
 * **Only the ids the journal names.** There is no code path here that takes a folder and moves its
 * contents. Undoing a rule that filed twenty messages must not sweep up the mail somebody filed
 * there by hand in the meantime — and a folder-shaped undo would do exactly that, invisibly and
 * irreversibly.
 *
 * **Rules first, mail second.** The filter is still running while the undo happens. Move the mail
 * back before removing the rule and Proton re-files it within the hour, which looks like the undo
 * silently failing.
 *
 * A message somebody has since moved by hand is skipped and named. Putting it back would be
 * overruling a person with a record of what a machine did earlier.
 */

export interface MessageState {
    ID: string;
    LabelIDs: string[];
}

export interface UndoContext {
    http: ProtonHttp;
    /** Undo the rule change itself. Injected so this file cannot reach the filter-write surface. */
    applyInverse: () => Promise<void>;
    /** Where the journalled messages are now, read before anything moves. */
    readCurrent: (ids: string[]) => Promise<MessageState[]>;
    /** Folder name to label id — the journal speaks in names, Proton answers in ids. */
    folderIds: Map<string, string>;
    now?: () => number;
}

export interface UndoOutcome {
    entryId: string;
    /** Messages actually moved back, grouped by where they went. */
    restored: Array<{ targetLabelId: string; messageIds: string[] }>;
    /** Moved by hand since the change, so deliberately left alone. */
    skippedMovedSince: string[];
    /** No resolvable previous folder in the snapshot. Reported, never guessed at. */
    unrestorable: string[];
    partial: AppError | undefined;
}

export async function undoChange(entry: JournalEntry, context: UndoContext): Promise<UndoOutcome> {
    const now = context.now ?? Date.now;

    if (entry.undoneAt !== undefined) {
        throw new AppError('UNDO_ENTRY_ALREADY_UNDONE', {
            message: 'Diese Änderung wurde bereits rückgängig gemacht.',
            hint: 'Ein zweites Zurücknehmen würde etwas anderes bedeuten als das erste.',
            context: { entryId: entry.id },
        });
    }

    // The rule first. While it still runs, Proton re-files anything moved back.
    await context.applyInverse();

    const ids = entry.moved.map((moved) => moved.messageId);
    if (ids.length === 0) {
        return { entryId: entry.id, restored: [], skippedMovedSince: [], unrestorable: [], partial: undefined };
    }

    const current = new Map((await context.readCurrent(ids)).map((state) => [state.ID, state.LabelIDs]));

    const byTarget = new Map<string, string[]>();
    const skippedMovedSince: string[] = [];
    const unrestorable: string[] = [];

    for (const moved of entry.moved) {
        const labels = current.get(moved.messageId);

        // Gone from the account, or no longer where the change put it: somebody has touched it.
        if (labels === undefined || (moved.movedTo !== undefined && !isIn(labels, moved.movedTo, context.folderIds))) {
            skippedMovedSince.push(moved.messageId);
            continue;
        }

        const target = previousFolderOf(moved, context.folderIds);
        if (target === undefined) {
            unrestorable.push(moved.messageId);
            continue;
        }

        const list = byTarget.get(target);
        if (list === undefined) {
            byTarget.set(target, [moved.messageId]);
        } else {
            list.push(moved.messageId);
        }
    }

    const restored: UndoOutcome['restored'] = [];
    for (const [targetLabelId, messageIds] of byTarget) {
        await moveMessagesBack(context.http, messageIds, targetLabelId);
        restored.push({ targetLabelId, messageIds });
    }

    const moved = restored.reduce((total, group) => total + group.messageIds.length, 0);
    log.info(
        { entryId: entry.id, moved, skipped: skippedMovedSince.length, unrestorable: unrestorable.length },
        'undo performed'
    );

    const partial =
        skippedMovedSince.length + unrestorable.length === 0
            ? undefined
            : new AppError('UNDO_PARTIAL_RESTORE', {
                  message: `${moved} von ${entry.moved.length} Mails zurückgelegt.`,
                  hint:
                      skippedMovedSince.length > 0
                          ? 'Der Rest wurde seither von Hand einsortiert und bleibt, wo er ist — eine ' +
                            'Person zu überstimmen ist nicht Aufgabe eines Rückgängig.'
                          : 'Für den Rest ist im Protokoll kein vorheriger Ordner vermerkt.',
                  context: {
                      moved,
                      expected: entry.moved.length,
                      skipped: skippedMovedSince.length,
                      unrestorable: unrestorable.length,
                  },
              });

    entry.undoneAt = now();
    return { entryId: entry.id, restored, skippedMovedSince, unrestorable, partial };
}

function isIn(labels: readonly string[], folderName: string, folderIds: Map<string, string>): boolean {
    const id = folderIds.get(folderName);
    return id !== undefined && labels.includes(id);
}

/**
 * Where a message was before the change.
 *
 * From the snapshot the journal recorded, and only from there. The first label that is a known
 * folder wins; a message carries several — the inbox, all mail — and picking by position rather
 * than by recognising a folder would land mail in whatever came first.
 */
function previousFolderOf(moved: MovedMessage, folderIds: Map<string, string>): string | undefined {
    const known = new Set(folderIds.values());
    const folder = moved.previousLabelIds.find((id) => known.has(id));
    if (folder !== undefined) {
        return folder;
    }
    // It was in the inbox and nowhere else, which is a destination like any other.
    return moved.previousLabelIds.includes(INBOX) ? INBOX : undefined;
}

const INBOX = '0';
