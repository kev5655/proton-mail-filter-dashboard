import { getLogger } from '@pms/core/logger';
import { z } from 'zod';

import type { ProtonHttp } from '../http.js';

/**
 * Moving messages. The single exception to the project's core rule, and the only file that breaks it.
 *
 * The tool does not sort mail — Proton's filters do. This exists solely for undo: when a rule is
 * taken back, the messages it moved have to come back too, and no filter can be asked to do that.
 *
 * Two constraints hold it in place. The caller passes explicit message ids taken from the undo
 * journal's snapshot, never a folder or a query — a mail filed there by hand afterwards is not this
 * change's to move. And `write-isolation.test.ts` asserts that nothing but the undo service imports
 * this module, so the exception cannot quietly become a habit.
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
