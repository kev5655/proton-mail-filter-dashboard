import { describeChange, type JournalEntry } from '@pms/changes';
import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

const log = getLogger('journal');

/**
 * Keeping the record of what was changed at the account.
 *
 * This is the piece that was missing rather than broken. `applyChange` already builds a correct
 * entry — its `moved` list comes from what verification *observed*, never from what the plan
 * intended, because an entry built from intentions would make undo move mail that never moved — and
 * the process that called it discarded the value. „Verlauf" was therefore empty against every real
 * account, and `undoChange` had no caller in the project at all.
 *
 * It lives in the encrypted local database beside the mirror, because it describes the same
 * mailbox and has the same reasons to stay on this machine. What it stores of a message is its id,
 * the labels it carried before, and where it went: enough to put it back, and not one field more.
 */

interface Row {
    id: string;
    at: number;
    kind: string;
    summary: string;
    change_json: string;
    inverse_json: string;
    moved_json: string;
    verification_json: string | null;
    backup_path: string;
    undone_at: number | null;
    undoes_id: string | null;
}

export interface StoredEntry extends JournalEntry {
    /** Where the full backup taken before this change went. */
    backupPath: string;
    /** Set when this entry is itself an undo, naming the entry it took back. */
    undoesId?: string | undefined;
}

/**
 * Write one entry.
 *
 * Called after the change landed and after verification looked, so what is stored is what happened.
 * A failure here must not lose the change that already succeeded — the caller logs and carries on,
 * because a written filter with no journal line is recoverable from the backup and an exception
 * thrown over the top of a successful write is not.
 */
export function recordJournalEntry(db: Db, entry: StoredEntry): void {
    db.prepare(
        `INSERT OR REPLACE INTO journal_entries
             (id, at, kind, summary, change_json, inverse_json, moved_json,
              verification_json, backup_path, undone_at, undoes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        entry.id,
        entry.at,
        entry.change.kind,
        describeChange(entry.change),
        JSON.stringify(entry.change),
        JSON.stringify(entry.inverse),
        JSON.stringify(entry.moved),
        entry.verification === undefined ? null : JSON.stringify(entry.verification),
        entry.backupPath,
        entry.undoneAt ?? null,
        entry.undoesId ?? null
    );
    log.info({ id: entry.id, kind: entry.change.kind, moved: entry.moved.length }, 'journal entry recorded');
    pruneJournal(db);
}

/**
 * How many changes the record keeps.
 *
 * A cap rather than a growing list, and the number is small on purpose. This record exists to be
 * *undone from*: it holds, per change, the id of every message that moved and the labels it carried
 * before. That is the smallest thing that can put mail back, and it is still mail metadata sitting
 * on a disk — so it is kept for as long as taking a change back is a real prospect and no longer.
 *
 * Twenty is roughly a session's worth of work. Beyond that, „rückgängig" stops being something
 * somebody does and becomes archaeology, and the backups on disk are the better tool for it: they
 * hold every filter and folder as they were before each change, and they are not deleted by this.
 */
export const JOURNAL_LIMIT = 20;

/**
 * Drop everything past the cap, oldest first.
 *
 * By `at` and then `id`, exactly the order the list is read in, so what disappears is what was
 * already at the bottom of the screen rather than whichever row SQLite happened to return last.
 */
export function pruneJournal(db: Db, limit = JOURNAL_LIMIT): number {
    const result = db
        .prepare(
            `DELETE FROM journal_entries
             WHERE id NOT IN (
                 SELECT id FROM journal_entries ORDER BY at DESC, id DESC LIMIT ?
             )`
        )
        .run(limit);
    const removed = Number(result.changes);
    if (removed > 0) {
        log.info({ removed, limit }, 'journal pruned to its limit');
    }
    return removed;
}

/**
 * Forget the record, on purpose.
 *
 * What this costs is stated where it is offered, because it cannot be taken back: undo works from
 * this table, so a change with no entry can no longer be reversed by this tool. What it does not
 * cost is the backups — they are files, this is a table, and clearing a history should not quietly
 * throw away the copy of every filter as it was before each change.
 */
export function clearJournal(db: Db): number {
    const result = db.prepare('DELETE FROM journal_entries').run();
    const removed = Number(result.changes);
    log.info({ removed }, 'journal cleared by the user');
    return removed;
}

/** Mark an entry taken back, so it is not offered a second time. */
export function markUndone(db: Db, entryId: string, at: number): void {
    db.prepare('UPDATE journal_entries SET undone_at = ? WHERE id = ?').run(at, entryId);
}

/** Newest first: the thing most likely to need taking back is the thing just done. */
export function readJournal(db: Db, limit = 200): StoredEntry[] {
    const rows = db
        .prepare('SELECT * FROM journal_entries ORDER BY at DESC, id DESC LIMIT ?')
        .all(limit) as Row[];

    return rows.map(toEntry);
}

export function readJournalEntry(db: Db, entryId: string): StoredEntry | undefined {
    const row = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId) as Row | undefined;
    return row === undefined ? undefined : toEntry(row);
}

/**
 * Everything applied at or after this entry that has not been taken back, newest first.
 *
 * The list a rewind works from. It is ordered newest-first because that is the order the steps have
 * to run in — undoing an older change before a newer one built on top of it would put the account
 * through a state nobody planned.
 */
export function readJournalSince(db: Db, entryId: string): StoredEntry[] {
    const anchor = readJournalEntry(db, entryId);
    if (anchor === undefined) {
        return [];
    }
    const rows = db
        .prepare(
            `SELECT * FROM journal_entries
             WHERE at >= ? AND undone_at IS NULL AND undoes_id IS NULL
             ORDER BY at DESC, id DESC`
        )
        .all(anchor.at) as Row[];

    return rows.map(toEntry);
}

function toEntry(row: Row): StoredEntry {
    return {
        id: row.id,
        at: row.at,
        change: JSON.parse(row.change_json) as StoredEntry['change'],
        inverse: JSON.parse(row.inverse_json) as StoredEntry['inverse'],
        moved: JSON.parse(row.moved_json) as StoredEntry['moved'],
        verification:
            row.verification_json === null
                ? undefined
                : (JSON.parse(row.verification_json) as StoredEntry['verification']),
        backupPath: row.backup_path,
        undoneAt: row.undone_at ?? undefined,
        undoesId: row.undoes_id ?? undefined,
    };
}
