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

export async function createFolder(http: ProtonHttp, payload: FolderPayload): Promise<ProtonLabel> {
    const response = await http.request(
        { method: 'POST', path: 'core/v4/labels', body: { ...payload, Type: LABEL_TYPE.FOLDER } },
        labelResponseSchema
    );
    log.info({ name: payload.Name, nested: payload.ParentID !== undefined }, 'folder created');
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
