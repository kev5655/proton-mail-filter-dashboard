import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageMetadata, ProtonLabel } from '@pms/proton-api/schemas';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorLabels, mirrorMessages, recordCategoryObservations } from '../src/mirror.js';

/**
 * Watching Proton sort mail, one sync at a time.
 *
 * Proton's categorisation is a rule with no interface: nothing reads it, nothing sets it, and
 * Proton's own client sends no request about it. The only way to see it at all is to remember what
 * was true last time and compare — which makes this file the test of the whole feature's premise
 * rather than of a helper.
 *
 * Two things are asserted throughout, and they are different: that a change is *recorded*, and that
 * an absence of change is not mistaken for one. A history that reports movement every sync is as
 * useless as one that reports none.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-one';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-cat-'));
    db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

const SYNC_ONE = 1_700_000_000;
const SYNC_TWO = 1_700_086_400;

function message(id: string, labelIds: string[], sender = 'werbung@beispiel.example'): MessageMetadata {
    return {
        ID: id,
        Subject: `Betreff ${id}`,
        Sender: { Address: sender, Name: 'Absender' },
        ToList: [{ Address: 'ich@beispiel.example' }],
        Time: SYNC_ONE,
        LabelIDs: labelIds,
        Unread: 0,
    };
}

function folder(id: string, name: string): ProtonLabel {
    return { ID: id, Name: name, Path: name, Type: 3 };
}

/** One sync, in the order `syncAll` performs it: mirror first, then record. */
function sync(messages: MessageMetadata[], observedAt: number): void {
    mirrorMessages(db, messages);
    recordCategoryObservations(db, messages, observedAt);
}

interface CategoryRow {
    message_id: string;
    category_id: string;
    first_seen: number;
    last_seen: number;
    gone_at: number | null;
}

function rows(): CategoryRow[] {
    return db
        .prepare('SELECT * FROM message_categories ORDER BY message_id, category_id')
        .all() as CategoryRow[];
}

describe('recording what Proton did', () => {
    it('opens a row the first time a message is seen in a category', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);

        expect(rows()).toEqual([
            { message_id: 'm-1', category_id: '21', first_seen: SYNC_ONE, last_seen: SYNC_ONE, gone_at: null },
        ]);
    });

    it('reports nothing new when a second sync sees the same thing', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);
        sync([message('m-1', ['0', '21'])], SYNC_TWO);

        const [row] = rows();
        // Still one row, still open, but the clock has moved: that is "confirmed again", which is
        // a different statement from "unchanged because we did not look".
        expect(rows()).toHaveLength(1);
        expect(row?.first_seen).toBe(SYNC_ONE);
        expect(row?.last_seen).toBe(SYNC_TWO);
        expect(row?.gone_at).toBeNull();
    });

    it('closes the old category and opens the new one when Proton changes its mind', () => {
        // The event the whole feature exists to catch.
        sync([message('m-1', ['0', '24'])], SYNC_ONE);
        sync([message('m-1', ['0', '21'])], SYNC_TWO);

        expect(rows()).toEqual([
            { message_id: 'm-1', category_id: '21', first_seen: SYNC_TWO, last_seen: SYNC_TWO, gone_at: null },
            { message_id: 'm-1', category_id: '24', first_seen: SYNC_ONE, last_seen: SYNC_ONE, gone_at: SYNC_TWO },
        ]);
    });

    it('records a category being lost with nothing taking its place', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);
        sync([message('m-1', ['0'])], SYNC_TWO);

        expect(rows()[0]?.gone_at).toBe(SYNC_TWO);
    });

    it('re-opens the same row when a category comes back', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);
        sync([message('m-1', ['0'])], SYNC_TWO);
        sync([message('m-1', ['0', '21'])], SYNC_TWO + 86_400);

        // One row, not two: the pair is the identity, and "it left and returned" is what the dates
        // say. A second row would make the same message look like two different observations.
        expect(rows()).toHaveLength(1);
        expect(rows()[0]?.gone_at).toBeNull();
    });

    it('ignores system locations and the account’s own folders', () => {
        mirrorLabels(db, { folders: [folder('27', 'Ein kurzer Ordner')], labels: [] });
        // 0 inbox, 5 all mail, 16 snoozed, 27 a folder that happens to have a short id.
        sync([message('m-1', ['0', '5', '16', '27'])], SYNC_ONE);

        expect(rows()).toEqual([]);
    });
});

describe('the per-sender aggregate', () => {
    it('counts a sender’s messages per category and sync', () => {
        sync(
            [
                message('m-1', ['0', '21'], 'werbung@shop.example'),
                message('m-2', ['0', '21'], 'werbung@shop.example'),
                message('m-3', ['0', '25'], 'brief@zeitung.example'),
            ],
            SYNC_ONE
        );

        const observations = db
            .prepare('SELECT sender_address, sender_domain, category_id, message_count FROM category_observations ORDER BY sender_address')
            .all();

        expect(observations).toEqual([
            { sender_address: 'brief@zeitung.example', sender_domain: 'zeitung.example', category_id: '25', message_count: 1 },
            { sender_address: 'werbung@shop.example', sender_domain: 'shop.example', category_id: '21', message_count: 2 },
        ]);
    });

    it('keeps each sync as its own observation rather than overwriting', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);
        sync([message('m-2', ['0', '21'])], SYNC_TWO);

        const times = db
            .prepare('SELECT DISTINCT observed_at FROM category_observations ORDER BY observed_at')
            .all() as Array<{ observed_at: number }>;

        // "Over how many syncs" is the basis every verdict on the Auto-Regeln screen rests on, so
        // collapsing two observations into one would quietly inflate the confidence of all of them.
        expect(times.map((row) => row.observed_at)).toEqual([SYNC_ONE, SYNC_TWO]);
    });
});

describe('the history is bound to the messages it describes', () => {
    it('refuses a row for a message the mirror does not have', () => {
        // Writing history for a message that is not in the copy would leave rows nothing can ever
        // resolve, explain or clean up. The foreign key is what makes that impossible, and it is
        // also what fixes the call order: this runs after `mirrorMessages`, not before.
        expect(() => {
            recordCategoryObservations(db, [message('nie-gespiegelt', ['0', '21'])], SYNC_ONE);
        }).toThrow(/FOREIGN KEY/);
    });

    it('takes a message’s history with it when the message goes', () => {
        sync([message('m-1', ['0', '21'])], SYNC_ONE);
        expect(rows()).toHaveLength(1);

        db.prepare('DELETE FROM messages WHERE id = ?').run('m-1');

        // Otherwise the table grows forever with rows describing mail nobody can look at.
        expect(rows()).toEqual([]);
    });
});
