import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtonHttp } from '@pms/proton-api';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMeta } from '../src/mirror.js';
import { readMessages } from '../src/query.js';
import { syncAll, type SyncProgress } from '../src/sync.js';

/**
 * The sync loop, against a Proton that exists only in this file.
 *
 * The real read functions are used rather than mocked — a fake `fetch` underneath them — so the
 * query building and the schema validation are part of what is checked. Mocking `getMessages` would
 * have tested that the loop calls a function, which is not the risky part.
 *
 * What is risky: pulling more of someone's mailbox than they agreed to, and reporting a partial
 * sync as if it were complete.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-one';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-engine-'));
    db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** A mailbox of `total` messages, served a page at a time like Proton does. */
function fakeProton(total: number): { http: ProtonHttp; pages: number[]; begins: Array<string | null> } {
    const pages: number[] = [];
    const begins: Array<string | null> = [];

    const fetchImpl = (async (input: URL | RequestInfo) => {
        const url = new URL(String(input));

        if (url.pathname.endsWith('core/v4/labels')) {
            const type = Number(url.searchParams.get('Type'));
            return json({
                Code: 1000,
                Labels: [{ ID: `l-${type}`, Name: `Label ${type}`, Path: `Label ${type}`, Type: type }],
            });
        }
        if (url.pathname.endsWith('mail/v4/filters')) {
            return json({ Code: 1000, Filters: [] });
        }
        if (url.pathname.endsWith('mail/v4/messages')) {
            const page = Number(url.searchParams.get('Page') ?? 0);
            const size = Number(url.searchParams.get('PageSize') ?? 100);
            pages.push(page);
            begins.push(url.searchParams.get('Begin'));

            const from = page * size;
            const count = Math.max(0, Math.min(size, total - from));
            return json({
                Code: 1000,
                Total: total,
                Messages: Array.from({ length: count }, (_unused, index) => ({
                    ID: `m${from + index}`,
                    Subject: `Betreff ${from + index}`,
                    Sender: { Address: 'absender@beispiel.example', Name: 'Absender' },
                    ToList: [{ Address: 'ich@beispiel.example' }],
                    Time: 1_700_000_000 - (from + index),
                    LabelIDs: ['inbox'],
                    Unread: 0,
                })),
            });
        }
        throw new Error(`unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    // Pacing is real behaviour, tested in proton-api. Here it would only add minutes.
    return {
        http: new ProtonHttp({ version: '0.0.0', fetchImpl, minIntervalMs: 0, jitterMs: 0 }),
        pages,
        begins,
    };
}

describe('syncing a mailbox', () => {
    it('walks every page until the mailbox is exhausted', async () => {
        const { http, pages } = fakeProton(250);

        const result = await syncAll(db, http, { pageSize: 100 });

        expect(result.messages).toBe(250);
        expect(pages).toEqual([0, 1, 2]);
        expect(result.truncated).toBe(false);
    });

    it('stops at the limit and says the copy is partial', async () => {
        // The user's own mailbox holds 13'000 messages. Pulling all of it to answer "which rules
        // would help" is a cost nobody agreed to, and a limit that silently looked complete would
        // make every count below it wrong without saying so.
        const { http } = fakeProton(1_000);

        const result = await syncAll(db, http, { pageSize: 100, maxMessages: 250 });

        expect(result.messages).toBe(250);
        expect(result.truncated).toBe(true);
        expect(readMessages(db, { limit: 1_000 })).toHaveLength(250);
    });

    it('honours the limit exactly, rather than to the end of a page', async () => {
        const { http } = fakeProton(1_000);

        const result = await syncAll(db, http, { pageSize: 100, maxMessages: 150 });

        expect(result.messages).toBe(150);
    });

    it('reports progress as it goes, because a paced sync takes minutes', async () => {
        const { http } = fakeProton(250);
        const seen: SyncProgress[] = [];

        await syncAll(db, http, { pageSize: 100, onProgress: (progress) => seen.push(progress) });

        expect(seen.map((entry) => entry.stage)).toContain('labels');
        expect(seen.filter((entry) => entry.stage === 'messages').map((entry) => entry.done)).toEqual([
            100, 200, 250,
        ]);
    });

    it('stops when cancelled, and does not claim to be complete', async () => {
        const controller = new AbortController();
        const { http } = fakeProton(1_000);

        const result = await syncAll(db, http, {
            pageSize: 100,
            signal: controller.signal,
            onProgress: (progress) => {
                if (progress.stage === 'messages' && progress.done >= 200) {
                    controller.abort();
                }
            },
        });

        expect(result.truncated).toBe(true);
        expect(result.messages).toBeLessThan(1_000);
    });

    it('records when it last ran, so a screen can say how stale it is', async () => {
        const { http } = fakeProton(10);

        await syncAll(db, http, { pageSize: 100 });

        expect(Number(getMeta(db, 'lastSyncAt'))).toBeGreaterThan(0);
    });

    it('handles an empty mailbox without looping', async () => {
        const { http, pages } = fakeProton(0);

        const result = await syncAll(db, http, { pageSize: 100 });

        expect(result.messages).toBe(0);
        expect(pages).toEqual([0]);
    });
});

/**
 * Fetching only what is new.
 *
 * The full run reads a year of mail one paced page at a time, which is minutes. Doing that every
 * time somebody presses „jetzt synchronisieren" — let alone every five minutes on a timer — asks
 * Proton for thirteen thousand messages it already gave us. Messages are upserted, so a narrow
 * window adds to the copy rather than replacing it with a smaller one.
 *
 * The window reaches back an hour past the recorded time on purpose. Proton orders by the message's
 * own timestamp, so a message that arrived during the previous run can carry a timestamp from just
 * before it started — and a hard boundary would skip it forever rather than once.
 */
describe('an incremental sync', () => {
    it('reads the whole window when there is no previous sync to be incremental against', async () => {
        const { http, begins } = fakeProton(120);

        await syncAll(db, http, { pageSize: 100, incremental: true });

        expect(begins.every((begin) => begin === null)).toBe(true);
    });

    it('asks only for what arrived since last time, with an hour of overlap', async () => {
        const { http } = fakeProton(120);
        await syncAll(db, http, { pageSize: 100 });
        const lastSync = Number(getMeta(db, 'lastSyncAt'));

        const second = fakeProton(120);
        await syncAll(db, second.http, { pageSize: 100, incremental: true });

        const begin = Number(second.begins[0]);
        expect(begin).toBe(lastSync - 3_600);
    });

    it('does not shrink the copy it already has', async () => {
        const { http } = fakeProton(120);
        await syncAll(db, http, { pageSize: 100 });

        // A second run that finds nothing new must leave all 120 in place, not 0.
        const second = fakeProton(0);
        await syncAll(db, second.http, { pageSize: 100, incremental: true });

        expect(readMessages(db, { limit: 500 })).toHaveLength(120);
    });

    it('does not claim the copy is complete when it only looked at a sliver', async () => {
        const { http } = fakeProton(250);
        await syncAll(db, http, { pageSize: 100, maxMessages: 150 });
        expect(getMeta(db, 'lastSyncTruncated')).toBe('1');

        // The incremental run finds little and finishes; that must not be read as "and by the way,
        // the copy is now complete" — the 100 messages it never fetched are still missing.
        const second = fakeProton(10);
        await syncAll(db, second.http, { pageSize: 100, incremental: true });

        expect(getMeta(db, 'lastSyncTruncated')).toBe('1');
    });
});
