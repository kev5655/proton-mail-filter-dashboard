import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { CATEGORY_LABELS } from '@pms/grouping';
import type { ProtonHttp } from '@pms/proton-api';
import { moveMessagesToCategory } from '@pms/proton-api/write/messages';

import type { MessageState } from './undo-service.js';

const log = getLogger('categories');

/**
 * Moving named messages into one of Proton's categories.
 *
 * The second documented exception to "this tool never moves mail", and written to the same shape as
 * the first. It exists because a category cannot be a filter's destination: Proton files mail into
 * „Werbung" or „Transaktionen" itself, learns from a message being moved there by hand, and offers
 * no endpoint that reads or sets what it learned. Moving the mail *is* the interface.
 *
 * What holds it narrow, in the order the constraints matter:
 *
 * **It cannot obtain an id.** There is no read here, no query, no "everything from this sender".
 * The caller passes ids that a person selected and then saw listed in a diff, and `readCurrent` is
 * injected so that even looking at those messages goes through somebody else's code.
 * `write-isolation.test.ts` checks the absence rather than trusting this paragraph.
 *
 * **It reports rather than rounds up.** A message that is gone, or already in the target category,
 * is named and not counted as moved. Both are ordinary — a mailbox changes between a sync and a
 * confirmation — and both would be invisible if the count came from the request instead of from
 * looking.
 *
 * **It snapshots first.** `previousLabelIds` per message, observed before anything moves, is what
 * undo works from. A snapshot taken afterwards, or derived from the plan, would put mail back to
 * where the plan thought it was rather than where it actually was.
 */

export interface CategoryMoveContext {
    http: ProtonHttp;
    /** Where the named messages are right now. Injected: this file may not read Proton itself. */
    readCurrent: (ids: string[]) => Promise<MessageState[]>;
}

export interface CategoryMoveOutcome {
    categoryId: string;
    /** Per message, its label set before the move — the record undo needs. */
    moved: Array<{ messageId: string; previousLabelIds: string[] }>;
    /** Already carried the target category, so nothing was asked of Proton for them. */
    alreadyThere: string[];
    /** Not returned by the read-back: deleted, or outside the window that read looks at. */
    missing: string[];
    partial: AppError | undefined;
}

export async function moveIntoCategory(
    messageIds: string[],
    categoryId: string,
    context: CategoryMoveContext
): Promise<CategoryMoveOutcome> {
    if (!(categoryId in CATEGORY_LABELS)) {
        throw new AppError('APPLY_MALFORMED', {
            message: `„${categoryId}" ist keine von Protons Kategorien.`,
            hint: 'Es wurde nichts verschoben.',
            context: { categoryId },
        });
    }
    if (messageIds.length === 0) {
        throw new AppError('APPLY_MALFORMED', {
            message: 'Die Änderung nennt keine Mails.',
            hint: 'Es wurde nichts verschoben. Ein Verschieben ohne Kennungen gibt es hier nicht.',
            context: { categoryId },
        });
    }

    const current = new Map((await context.readCurrent(messageIds)).map((state) => [state.ID, state.LabelIDs]));

    const moved: CategoryMoveOutcome['moved'] = [];
    const alreadyThere: string[] = [];
    const missing: string[] = [];

    for (const messageId of messageIds) {
        const labels = current.get(messageId);
        if (labels === undefined) {
            missing.push(messageId);
            continue;
        }
        if (labels.includes(categoryId)) {
            alreadyThere.push(messageId);
            continue;
        }
        moved.push({ messageId, previousLabelIds: [...labels] });
    }

    if (moved.length > 0) {
        await moveMessagesToCategory(context.http, moved.map((entry) => entry.messageId), categoryId);
    }

    log.info(
        { categoryId, moved: moved.length, alreadyThere: alreadyThere.length, missing: missing.length },
        'moved messages into a category'
    );

    const partial =
        missing.length === 0
            ? undefined
            : new AppError('APPLY_PARTIAL', {
                  message: `${String(moved.length)} von ${String(messageIds.length)} Mails verschoben.`,
                  hint:
                      'Die übrigen waren nicht mehr dort, wo die lokale Kopie sie vermutet — gelöscht, ' +
                      'oder ausserhalb des Bereichs, den die Nachkontrolle liest. Verschoben wurde nur, ' +
                      'was gefunden wurde.',
                  context: {
                      categoryId,
                      moved: moved.length,
                      requested: messageIds.length,
                      missing: missing.length,
                      alreadyThere: alreadyThere.length,
                  },
              });

    return { categoryId, moved, alreadyThere, missing, partial };
}
