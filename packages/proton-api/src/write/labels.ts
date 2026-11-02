import { getLogger } from '@pms/core/logger';
import { z } from 'zod';

import type { ProtonHttp } from '../http.js';
import { labelSchema, LABEL_TYPE, type ProtonLabel } from '../schemas.js';

/**
 * Creating, renaming and deleting folders.
 *
 * Deleting is the dangerous one, and not because of the mail: Proton moves that to Archive. It is
 * dangerous because a rule pointing at the deleted folder keeps running and files into nothing,
 * silently. The caller must therefore have shown the user which rules target the folder — the
 * folder screen does — before calling this.
 */

const log = getLogger('proton-write');

const labelResponseSchema = z.object({ Code: z.number(), Label: labelSchema });
const envelopeSchema = z.object({ Code: z.number() });

export interface FolderPayload {
    Name: string;
    Color: string;
    /** Omit for a top-level folder; Proton nests by parent id. */
    ParentID?: string;
    Notify?: number;
}

/**
 * Create a folder, or a label.
 *
 * They are the same object at Proton with a different `Type`, and the same endpoint makes both. The
 * difference is entirely in what a filter filing into the name then does: a folder moves the mail
 * out of the inbox, a label marks it and leaves it there.
 *
 * `Type` is a parameter rather than a hardcoded constant now, and the default is still `FOLDER` —
 * the caller that means a label has to say so. Somebody typing a new label name used to get a
 * folder, silently, and then a rule that moved mail they meant to merely mark.
 */
export async function createFolder(
    http: ProtonHttp,
    payload: FolderPayload,
    type: number = LABEL_TYPE.FOLDER
): Promise<ProtonLabel> {
    const response = await http.request(
        { method: 'POST', path: 'core/v4/labels', body: { ...payload, Type: type } },
        labelResponseSchema
    );
    log.info(
        { name: payload.Name, nested: payload.ParentID !== undefined, type },
        type === LABEL_TYPE.LABEL ? 'label created' : 'folder created'
    );
    return response.Label;
}

export async function updateFolder(
    http: ProtonHttp,
    labelId: string,
    payload: FolderPayload
): Promise<ProtonLabel> {
    const response = await http.request(
        { method: 'PUT', path: `core/v4/labels/${labelId}`, body: payload },
        labelResponseSchema
    );
    log.info({ labelId, name: payload.Name }, 'folder updated');
    return response.Label;
}

export async function deleteFolder(http: ProtonHttp, labelId: string): Promise<void> {
    await http.request({ method: 'DELETE', path: `core/v4/labels/${labelId}` }, envelopeSchema);
    log.info({ labelId }, 'folder deleted');
}
