import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type Db } from '../src/database.js';
import { MIGRATIONS } from '../src/schema.js';

/**
 * The step that repairs journal timestamps written in the wrong unit.
 *
 * `at` always meant Unix seconds — the column said so, the DTO said so, the tests said so, and
 * `undone_at` in the very same row was written that way. The one place that disagreed was the
 * writer, which sent `Date.now()`. Every applied change was therefore recorded a thousand times too
 * far in the future: the history displayed „13.4.58647", and `readJournalSince` compared a rewind
 * chain against a number no row could ever reach.
 *
 * The repair is asserted here rather than through `openDatabase` alone, because a fresh database
 * has nothing to repair — the interesting case is the one already on somebody's disk.
 */

const PASSPHRASE = 'eine-lange-zufaellige-passphrase';

/** The step under test. Named by its position so a reordering breaks this rather than passing. */
const REPAIR = MIGRATIONS[3];

let directory: string;
let path: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-journal-'));
    path = join(directory, 'mailbox.db');
    db = await openDatabase({ path, passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

function insert(id: string, at: number, undoneAt: number | null, checkedAt: number | null): void {
    db.prepare(
        `INSERT INTO journal_entries
             (id, at, kind, summary, change_json, inverse_json, moved_json,
              verification_json, backup_path, undone_at, undoes_id)
         VALUES (?, ?, 'create-rule', 'Regel anlegen', '{}', '{}', '[]', ?, '/tmp/backup.json', ?, NULL)`
    ).run(
        id,
        at,
        checkedAt === null ? null : JSON.stringify({ confirmed: 1, stragglers: [], checkedAt }),
        undoneAt
    );
}

function row(id: string): { at: number; undone_at: number | null; verification_json: string | null } {
    return db.prepare('SELECT at, undone_at, verification_json FROM journal_entries WHERE id = ?').get(id) as {
        at: number;
        undone_at: number | null;
        verification_json: string | null;
    };
}

describe('repairing journal timestamps that were written in milliseconds', () => {
    it('rescales a row the old writer left behind', () => {
        insert('alt', 1_700_000_000_500, 1_700_000_100_500, 1_700_000_000_500);

        db.exec(REPAIR?.sql ?? '');

        const repaired = row('alt');
        expect(repaired.at).toBe(1_700_000_000);
        expect(repaired.undone_at).toBe(1_700_000_100);
        expect(JSON.parse(repaired.verification_json ?? '{}')).toMatchObject({ checkedAtSeconds: 1_700_000_000 });
    });

    it('renames the instant inside the verification blob rather than keeping both', () => {
        insert('alt', 1_700_000_000_500, null, 1_700_000_000_500);

        db.exec(REPAIR?.sql ?? '');

        // Two fields for one instant is how the disagreement started; leaving the old one behind
        // would let a later reader pick the wrong half.
        expect(repairKeys('alt')).toEqual(['checkedAtSeconds', 'confirmed', 'stragglers']);
    });

    it('leaves a row that was already in seconds exactly as it is', () => {
        insert('neu', 1_700_000_000, 1_700_000_100, 1_700_000_000);

        db.exec(REPAIR?.sql ?? '');

        const untouched = row('neu');
        expect(untouched.at).toBe(1_700_000_000);
        expect(untouched.undone_at).toBe(1_700_000_100);
    });

    it('can run twice without halving anything', () => {
        // The threshold is what makes this true — 100000000000 is the year 5138 read as seconds
        // and 1973 read as milliseconds, so no plausible instant is ambiguous. A migration that is
        // safe to repeat is one that cannot be made worse by an interrupted upgrade.
        insert('alt', 1_700_000_000_500, null, null);

        db.exec(REPAIR?.sql ?? '');
        db.exec(REPAIR?.sql ?? '');

        expect(row('alt').at).toBe(1_700_000_000);
    });

    it('is the step this file thinks it is', () => {
        expect(REPAIR?.summary).toContain('milliseconds');
    });
});

function repairKeys(id: string): string[] {
    return Object.keys(JSON.parse(row(id).verification_json ?? '{}') as Record<string, unknown>).sort();
}
