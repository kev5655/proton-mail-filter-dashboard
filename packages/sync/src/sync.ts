import { getLogger } from '@pms/core/logger';
import {
    fingerprintAccount,
    getFilters,
    getFolders,
    getLabels,
    getMessages,
    type ProtonHttp,
} from '@pms/proton-api';
import type { Db } from '@pms/store';

import { getMeta, mirrorFilters, mirrorLabels, mirrorMessages, setMeta } from './mirror.js';

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
    /**
     * Fetch only what arrived since the last completed sync.
     *
     * Messages are upserted, never replaced, so an incremental run adds to the copy rather than
     * narrowing it. The window starts a little before the recorded time — Proton orders by the
     * message's own timestamp, and a message that arrived during the previous run can carry a
     * timestamp from just before it, which a hard boundary would skip forever.
     *
     * Folders and filters are always read in full. They are three requests, and they are what every
     * refusal and every diff is compared against.
     */
    incremental?: boolean;
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

/** How far back an incremental run reaches beyond the last sync. One hour, for clock skew and slow pages. */
const INCREMENTAL_OVERLAP_SECONDS = 3_600;

export async function syncAll(db: Db, http: ProtonHttp, options: SyncOptions = {}): Promise<SyncResult> {
    const report = options.onProgress ?? ((): void => {});
    const effective = options.incremental === true ? withIncrementalWindow(db, options) : options;

    // Folders and labels first: a message references them, and a rule files into them. Fetching
    // them after the messages would mean a window where the copy names a folder it cannot resolve.
    const folders = await getFolders(http);
    const labels = await getLabels(http);
    const labelCount = mirrorLabels(db, { folders, labels });
    report({ stage: 'labels', done: labelCount, total: labelCount });

    const filters = await getFilters(http);
    const filterCount = mirrorFilters(db, filters);
    report({ stage: 'filters', done: filterCount, total: filterCount });

    const { messages, truncated } = await syncMessages(db, http, effective, report);

    // What the account looked like at this moment.
    //
    // A write is refused when the account has moved since the plan was computed, and this is the
    // "since" — the browser sees only the mirror, so the comparison has to be against what was true
    // when the mirror was made.
    setMeta(db, 'accountVersion', fingerprintAccount(filters, folders));
    setMeta(db, 'lastSyncAt', String(Math.floor(Date.now() / 1000)));
    // Recorded, not just returned. Whether the copy is complete outlives the run that made it, and
    // anything reading the database later — the dashboard above all — has to be able to say "these
    // are the mails I know about" rather than implying it has the account.
    // An incremental run only ever looked at part of the mailbox, so it must not claim the copy is
    // complete — nor claim it is truncated when the full run before it was not.
    if (options.incremental !== true) {
        setMeta(db, 'lastSyncTruncated', truncated ? '1' : '0');
    } else if (truncated) {
        setMeta(db, 'lastSyncTruncated', '1');
    }
    log.info(
        { labels: labelCount, filters: filterCount, messages, truncated, incremental: options.incremental === true },
        'sync complete'
    );

    return { labels: labelCount, filters: filterCount, messages, truncated };
}

/**
 * The same options, with the window narrowed to what has happened since last time.
 *
 * Falls back to the caller's window when there is no recorded sync: a first run has nothing to be
 * incremental against, and quietly fetching only the last hour would leave an almost empty copy
 * that looks like a full one.
 */
function withIncrementalWindow(db: Db, options: SyncOptions): SyncOptions {
    const last = Number(getMeta(db, 'lastSyncAt') ?? NaN);
    if (!Number.isFinite(last)) {
        log.info({}, 'no previous sync recorded; reading the full window');
        return options;
    }

    const begin = Math.max(0, Math.floor(last) - INCREMENTAL_OVERLAP_SECONDS);
    log.info({ begin }, 'incremental sync');
    return { ...options, window: { ...options.window, begin } };
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

/**
 * Bring the filters and folders back in step, without touching the messages.
 *
 * Run straight after a change lands at Proton. Two things depend on it, and both were broken while
 * it did not exist:
 *
 *  - **The fingerprint.** Every write is refused when the account no longer matches the copy the
 *    plan was built on. Writing a filter changes the account, so without this the *next* change was
 *    always refused as stale — which is what "I still cannot create a rule" turned out to be.
 *  - **The dashboard.** It renders the mirror. A rule saved at Proton and absent from the mirror
 *    reads as a save that did not happen.
 *
 * Three GETs. Messages are left alone deliberately: a filter moves mail asynchronously, so reading
 * them here would record a half-finished state as if it were the result.
 */
export async function refreshAccountObjects(
    db: Db,
    http: ProtonHttp
): Promise<{ folders: number; filters: number; version: string }> {
    const folders = await getFolders(http);
    const labels = await getLabels(http);
    const filters = await getFilters(http);

    mirrorLabels(db, { folders, labels });
    mirrorFilters(db, filters);

    const version = fingerprintAccount(filters, folders);
    setMeta(db, 'accountVersion', version);
    log.info({ folders: folders.length, filters: filters.length }, 'account objects refreshed');

    return { folders: folders.length, filters: filters.length, version };
}
