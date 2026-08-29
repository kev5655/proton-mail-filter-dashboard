import type { ProtonHttp } from './http.js';
import {
    filtersResponseSchema,
    labelsResponseSchema,
    LABEL_TYPE,
    messageCountsResponseSchema,
    messagesResponseSchema,
    type MessageMetadata,
    type ProtonFilter,
    type ProtonLabel,
} from './schemas.js';

/**
 * Read-only access to Proton.
 *
 * Everything in this module is a GET. Writes live under `write/` and are the only place allowed to
 * change anything in the account — see the project's core rule in CLAUDE.md.
 */

export async function getFilters(http: ProtonHttp): Promise<ProtonFilter[]> {
    const response = await http.request({ method: 'GET', path: 'mail/v4/filters' }, filtersResponseSchema);
    return response.Filters;
}

export async function getFolders(http: ProtonHttp): Promise<ProtonLabel[]> {
    const response = await http.request(
        { method: 'GET', path: 'core/v4/labels', query: { Type: LABEL_TYPE.FOLDER } },
        labelsResponseSchema
    );
    return response.Labels;
}

export async function getLabels(http: ProtonHttp): Promise<ProtonLabel[]> {
    const response = await http.request(
        { method: 'GET', path: 'core/v4/labels', query: { Type: LABEL_TYPE.LABEL } },
        labelsResponseSchema
    );
    return response.Labels;
}

export interface MessageQuery {
    /** Restrict to one label or folder. Omit for the whole account. */
    labelId?: string;
    /** Unix seconds, inclusive. */
    begin?: number;
    end?: number;
    page?: number;
    pageSize?: number;
}

export interface MessagePage {
    total: number;
    messages: MessageMetadata[];
}

export async function getMessages(http: ProtonHttp, query: MessageQuery = {}): Promise<MessagePage> {
    const response = await http.request(
        {
            method: 'GET',
            path: 'mail/v4/messages',
            query: {
                LabelID: query.labelId,
                Begin: query.begin,
                End: query.end,
                Page: query.page ?? 0,
                PageSize: query.pageSize ?? 100,
                Sort: 'Time',
                Desc: 1,
            },
        },
        messagesResponseSchema
    );
    return { total: response.Total, messages: response.Messages };
}

/**
 * How many messages fall in a time range, without downloading them.
 *
 * This is what lets the import screen show "1 Jahr → 5'000 Mails" *before* you commit to an import,
 * so the choice is made against a real number rather than a guess. One request per range.
 */
export async function countMessagesInRange(
    http: ProtonHttp,
    range: { begin?: number; end?: number; labelId?: string } = {}
): Promise<number> {
    const page = await getMessages(http, { ...range, page: 0, pageSize: 1 });
    return page.total;
}

/** Per-folder totals, as Proton counts them. */
export async function getMessageCounts(
    http: ProtonHttp
): Promise<Array<{ LabelID: string; Total: number; Unread: number }>> {
    const response = await http.request(
        { method: 'GET', path: 'mail/v4/messages/count' },
        messageCountsResponseSchema
    );
    return response.Counts;
}
