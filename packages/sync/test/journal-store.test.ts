import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JournalEntry } from '@pms/changes';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { markUndone, readJournal, readJournalEntry, readJournalSince, recordJournalEntry } from '../src/journal-store.js';

/**
 * The record of what was changed, and the reason it has to be on disk.
 *
 * It used to live in a browser tab, written only by the demo branch — so against a real mailbox
 * „Verlauf" was permanently empty, and `undoChange` had no caller anywhere in the project. The write
 * path built a correct entry every time and the process that called it dropped the value.
 *
 * What matters here is not that rows come back. It is that they come back *complete enough to undo
 * from*: the per-message snapshot is the whole difference between putting twenty named messages
 * back where each of them was and emptying a folder.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-one';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-journal-'));
    db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

function entry(over: Partial<JournalEntry> & { id: string; at: number }): JournalEntry & { backupPath: string } {
    return {
        change: { id: 'c-1', kind: 'create-rule' },
        inverse: { id: 'c-1-undo', kind: 'delete-rule' },
        moved: [
            { messageId: 'm-1', previousLabelIds: ['0'], movedTo: 'Werbung' },
            { messageId: 'm-2', previousLabelIds: ['l-archiv'], movedTo: 'Werbung' },
        ],
        backupPath: '/tmp/backup.json',
        ...over,
    };
}

describe('keeping the record', () => {
    it('returns what undo needs, per message', () => {
        // Two messages that came from two different places. A description of the change could not
        // express that, which is exactly why the snapshot exists.
        recordJournalEntry(db, entry({ id: 'j-1', at: 1_700_000_000 }));

        expect(readJournalEntry(db, 'j-1')?.moved).toEqual([
            { messageId: 'm-1', previousLabelIds: ['0'], movedTo: 'Werbung' },
            { messageId: 'm-2', previousLabelIds: ['l-archiv'], movedTo: 'Werbung' },
        ]);
    });

    it('survives being closed and reopened', async () => {
        recordJournalEntry(db, entry({ id: 'j-1', at: 1_700_000_000 }));
        closeDatabase(db);

        db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });

        expect(readJournal(db)).toHaveLength(1);
    });

    it('lists the newest first, because that is what needs taking back', () => {
        recordJournalEntry(db, entry({ id: 'j-1', at: 1_700_000_000 }));
        recordJournalEntry(db, entry({ id: 'j-2', at: 1_700_000_100 }));

        expect(readJournal(db).map((row) => row.id)).toEqual(['j-2', 'j-1']);
    });

    it('marks an entry taken back rather than deleting it', () => {
        // A history that removes its own entries is not a history. „Rückgängig gemacht" is itself
        // something that happened and belongs on the screen.
        recordJournalEntry(db, entry({ id: 'j-1', at: 1_700_000_000 }));
        markUndone(db, 'j-1', 1_700_000_500);

        expect(readJournal(db)).toHaveLength(1);
        expect(readJournalEntry(db, 'j-1')?.undoneAt).toBe(1_700_000_500);
    });
});

describe('the chain a rewind would follow', () => {
    beforeEach(() => {
        recordJournalEntry(db, entry({ id: 'j-1', at: 1_700_000_000 }));
        recordJournalEntry(db, entry({ id: 'j-2', at: 1_700_000_100 }));
        recordJournalEntry(db, entry({ id: 'j-3', at: 1_700_000_200 }));
    });

    it('runs newest first, and includes the anchor', () => {
        // Undoing an older change before a newer one built on top of it would put the account
        // through a state nobody planned.
        expect(readJournalSince(db, 'j-2').map((row) => row.id)).toEqual(['j-3', 'j-2']);
    });

    it('leaves out what has already been taken back', () => {
        markUndone(db, 'j-3', 1_700_000_300);

        expect(readJournalSince(db, 'j-2').map((row) => row.id)).toEqual(['j-2']);
    });

    it('never walks back over an undo', () => {
        // An undo is itself an entry. Rewinding across one would undo the undoing, which is a redo
        // wearing the wrong name — and would let two entries disagree about the account.
        recordJournalEntry(db, { ...entry({ id: 'j-4', at: 1_700_000_400 }), undoesId: 'j-3' });

        expect(readJournalSince(db, 'j-1').map((row) => row.id)).toEqual(['j-3', 'j-2', 'j-1']);
    });
});
