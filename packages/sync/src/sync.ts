import { getLogger } from '@pms/core/logger';
import { getFilters, getFolders, getLabels, getMessages, type ProtonHttp } from '@pms/proton-api';
import type { Db } from '@pms/store';

import { mirrorFilters, mirrorLabels, mirrorMessages, setMeta } from './mirror.js';

const log = getLogger('sync');

/**
 * Bringing the local copy up to date with Proton.
 *
 * Read-only against the account, in the strict sense: every call here is a GET. What it writes, it
 * writes locally.
 *
 * Two things shape the design. The pacing in `ProtonHttp` means a page costs about a second, so a
 * year of mail is minutes rather than seconds — which is fine, and is why this reports progress
 * instead of blocking silently. And the window is chosen by the user rather than assumed: their
 * mailbox holds thirteen thousand messages, and downloading all of it to answer "which rules would
 * help" is a cost nobody agreed to.
 */

export interface SyncWindow {
    /** Unix seconds. Omit for the whole account. */
    begin?: number | undefined;
    end?: number | undefined;
}

export interface SyncProgress {
    stage: 'labels' | 'filters' | 'messages';
    /** How many objects have been written so far in this stage. */
    done: number;
    /** Total for the stage where Proton tells us up front; undefined until then. */
    total?: number | undefined;
}

export interface SyncOptions {
    window?: SyncWindow;
    /** Stops after this many messages. A guard against an unattended run pulling a whole account. */
    maxMessages?: number;
    pageSize?: number;
    onProgress?: (progress: SyncProgress) => void;
    /** Checked between pages, so a cancelled sync stops within about a second. */
    signal?: AbortSignal;
}

export interface SyncResult {
    labels: number;
    filters: number;
    messages: number;
    /** True when the run was cut short, so the caller can say so rather than imply completeness. */
    truncated: boolean;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_MESSAGES = 5_000;

export async function syncAll(db: Db, http: ProtonHttp, options: SyncOptions = {}): Promise<SyncResult> {
    const report = options.onProgress ?? ((): void => {});

    // Folders and labels first: a message references them, and a rule files into them. Fetching
    // them after the messages would mean a window where the copy names a folder it cannot resolve.
    const folders = await getFolders(http);
    const labels = await getLabels(http);
    const labelCount = mirrorLabels(db, { folders, labels });
    report({ stage: 'labels', done: labelCount, total: labelCount });

    const filters = await getFilters(http);
    const filterCount = mirrorFilters(db, filters);
    report({ stage: 'filters', done: filterCount, total: filterCount });

    const { messages, truncated } = await syncMessages(db, http, options, report);

    setMeta(db, 'lastSyncAt', String(Math.floor(Date.now() / 1000)));
    // Recorded, not just returned. Whether the copy is complete outlives the run that made it, and
    // anything reading the database later — the dashboard above all — has to be able to say "these
    // are the mails I know about" rather than implying it has the account.
    setMeta(db, 'lastSyncTruncated', truncated ? '1' : '0');
    log.info({ labels: labelCount, filters: filterCount, messages, truncated }, 'sync complete');

    return { labels: labelCount, filters: filterCount, messages, truncated };
}

async function syncMessages(
    db: Db,
    http: ProtonHttp,
    options: SyncOptions,
    report: (progress: SyncProgress) => void
): Promise<{ messages: number; truncated: boolean }> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const limit = options.maxMessages ?? DEFAULT_MAX_MESSAGES;

    let done = 0;
    let page = 0;
    let total: number | undefined;

    for (;;) {
        if (options.signal?.aborted === true) {
            log.info({ done }, 'sync cancelled');
            return { messages: done, truncated: true };
        }

        const result = await getMessages(http, {
            ...(options.window?.begin === undefined ? {} : { begin: options.window.begin }),
            ...(options.window?.end === undefined ? {} : { end: options.window.end }),
            page,
            pageSize,
        });
        total ??= Math.min(result.total, limit);

        if (result.messages.length === 0) {
            break;
        }

        // Trim rather than overshoot: the limit is a promise to the user about how much of their
        // mailbox this will pull, and a page is 100 messages wide.
        const room = limit - done;
        const batch = result.messages.length > room ? result.messages.slice(0, room) : result.messages;

        done += mirrorMessages(db, batch);
        report({ stage: 'messages', done, total });

        if (done >= limit) {
            return { messages: done, truncated: done < result.total };
        }
        if (done >= result.total) {
            break;
        }
        page += 1;
    }

    return { messages: done, truncated: false };
}
