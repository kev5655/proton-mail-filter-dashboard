import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { CATEGORY_LABELS } from '@pms/grouping';
import { z } from 'zod';

import type { ProtonHttp } from '../http.js';

/**
 * Moving messages. The two exceptions to the project's core rule, and the only file that breaks it.
 *
 * The tool does not sort mail — Proton's filters do. Two things cannot be expressed as a filter and
 * are therefore done here, each named in CLAUDE.md and each held to the same shape:
 *
 *  - **Undo**, putting back exactly the messages a change moved, from the journal's snapshot.
 *  - **Moving into one of Proton's categories.** A category is not a folder and no filter can file
 *    into one; Proton's own client moves the mail and lets the server learn from it.
 *
 * Three constraints hold both in place, and they are the whole design:
 *
 * **Only explicit ids.** Every function here takes `messageIds: string[]` as its second parameter,
 * and there is nothing in this file that can obtain one. A folder-shaped or query-shaped move would
 * sweep up mail somebody filed by hand, invisibly; the signature is what makes that impossible
 * rather than merely discouraged.
 *
 * **Messages, not conversations.** Proton's API has both. Labelling a conversation moves the whole
 * thread, which is more than the user selected — so the conversation variant is deliberately absent
 * even though it is what Proton's own web client sends.
 *
 * **A closed set of importers.** `write-isolation.test.ts` asserts the exact two files that may
 * import this module. An exception anything can reach is not an exception; it is the behaviour.
 */

const log = getLogger('proton-write');

const envelopeSchema = z.object({ Code: z.number() });

/** Proton caps a batch; larger sets are split so a partial failure is visible per chunk. */
const BATCH_SIZE = 100;

export async function moveMessagesBack(
    http: ProtonHttp,
    messageIds: string[],
    targetLabelId: string
): Promise<void> {
    for (let index = 0; index < messageIds.length; index += BATCH_SIZE) {
        const batch = messageIds.slice(index, index + BATCH_SIZE);
        await http.request(
            {
                method: 'POST',
                path: 'mail/v4/messages/batch/move',
                body: { IDs: batch, LabelID: targetLabelId },
            },
            envelopeSchema
        );
        log.info({ count: batch.length, targetLabelId }, 'undo moved messages back');
    }
}

/**
 * Move messages into one of Proton's categories.
 *
 * The endpoint was recorded from Proton's own client moving a mail into „Transaktionen" — `PUT
 * mail/v4/conversations/label`, body `{ LabelID, IDs }`, answered 200 — and then matched against
 * `packages/shared/lib/api/messages.ts` in ProtonMail/WebClients, which defines `labelMessages` as
 * the message-shaped sibling of the same call. That is the one used here.
 *
 * `SpamAction` is omitted on purpose: it steers Proton's spam handling and has nothing to do with
 * categories, and sending a field whose meaning we have not established would be guessing in a
 * request that moves somebody's mail.
 *
 * What this cannot promise, and what the interface therefore does not claim: whether the category
 * the message had before falls away by itself. Proton's client sends this one request and no
 * `unlabel`, which suggests the server treats categories as mutually exclusive — suggests, not
 * shows. The first real run settles it; until then nothing here says it either way.
 */
export async function moveMessagesToCategory(
    http: ProtonHttp,
    messageIds: string[],
    categoryId: string
): Promise<void> {
    // By construction this function can label a message with a category and with nothing else. A
    // folder id, a user label, a typo — all refused here rather than sent and regretted.
    if (!(categoryId in CATEGORY_LABELS)) {
        throw new AppError('APPLY_MALFORMED', {
            message: `„${categoryId}" ist keine von Protons Kategorien.`,
            hint: 'Es wurde nichts verschoben.',
            context: { categoryId, known: Object.keys(CATEGORY_LABELS).join(', ') },
        });
    }

    for (let index = 0; index < messageIds.length; index += BATCH_SIZE) {
        const batch = messageIds.slice(index, index + BATCH_SIZE);
        await http.request(
            {
                method: 'PUT',
                path: 'mail/v4/messages/label',
                body: { LabelID: categoryId, IDs: batch },
            },
            envelopeSchema
        );
        log.info({ count: batch.length, categoryId }, 'moved messages into a Proton category');
    }
}
