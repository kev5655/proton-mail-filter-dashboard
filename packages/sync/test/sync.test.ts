import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageMetadata, ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { markAdopted, mirrorFilters, mirrorLabels, mirrorMessages } from '../src/mirror.js';
import { readFilters, readFolderTree, readMessages } from '../src/query.js';

/**
 * The local copy says what Proton said — including what Proton stopped saying.
 *
 * Most of the risk in a mirror is not in writing new things but in failing to remove old ones. A
 * folder deleted in Proton that survives here becomes a destination this tool offers the user, or a
 * rule target that no longer exists. A message that moved folders and kept its old label is filed
 * in two places at once, and every count built on it is wrong.
 *
 * So most of what follows is about disappearance.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-one';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-sync-'));
    db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

function folder(id: string, name: string, parentId?: string): ProtonLabel {
    return { ID: id, Name: name, Path: name, Type: 3, ...(parentId === undefined ? {} : { ParentID: parentId }) };
}

function message(id: string, labelIds: string[], time = 1_700_000_000): MessageMetadata {
    return {
        ID: id,
        Subject: `Betreff ${id}`,
        Sender: { Address: `${id}@beispiel.example`, Name: `Absender ${id}` },
        ToList: [{ Address: 'ich@beispiel.example' }],
        Time: time,
        LabelIDs: labelIds,
        Unread: 0,
    };
}

function filter(id: string, priority: number, simple: boolean): ProtonFilter {
    return {
        ID: id,
        Name: `Regel ${id}`,
        Status: 1,
        Priority: priority,
        Version: 2,
        Sieve: 'keep;',
        Tree: [{ Type: 'Require' }],
        ...(simple
            ? {
                  Simple: {
                      Operator: { value: 'all', label: 'All' },
                      Conditions: [],
                      Actions: { FileInto: ['Archiv'], Mark: { Read: false, Starred: false } },
                  },
              }
            : {}),
    };
}

describe('mirroring folders', () => {
    it('drops a folder that Proton no longer returns', () => {
        mirrorLabels(db, { folders: [folder('f1', 'Rechnungen'), folder('f2', 'Weg damit')], labels: [] });
        mirrorLabels(db, { folders: [folder('f1', 'Rechnungen')], labels: [] });

        expect(readFolderTree(db).map((entry) => entry.id)).toEqual(['f1']);
    });

    it('picks up a rename rather than adding a second folder', () => {
        mirrorLabels(db, { folders: [folder('f1', 'Alt')], labels: [] });
        mirrorLabels(db, { folders: [folder('f1', 'Neu')], labels: [] });

        const tree = readFolderTree(db);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.name).toBe('Neu');
    });

    it('nests children and records their depth', () => {
        mirrorLabels(db, {
            folders: [folder('f1', 'Post'), folder('f2', 'Rechnungen', 'f1'), folder('f3', '2026', 'f2')],
            labels: [],
        });

        const [root] = readFolderTree(db);
        expect(root?.depth).toBe(0);
        expect(root?.children[0]?.name).toBe('Rechnungen');
        expect(root?.children[0]?.children[0]?.depth).toBe(2);
    });

    it('treats an empty ParentID as top level, which is how Proton writes it', () => {
        mirrorLabels(db, { folders: [{ ...folder('f1', 'Oben'), ParentID: '' }], labels: [] });

        expect(readFolderTree(db)).toHaveLength(1);
    });

    it('shows a folder whose parent is missing rather than losing it', () => {
        // An orphan means the copy is inconsistent. Hiding it would look like data loss to someone
        // who can see the folder in Proton.
        mirrorLabels(db, { folders: [folder('f2', 'Verwaist', 'gibt-es-nicht')], labels: [] });

        expect(readFolderTree(db).map((entry) => entry.name)).toEqual(['Verwaist']);
    });
});

describe('mirroring filters', () => {
    it('keeps them in the order Proton runs them', () => {
        mirrorFilters(db, [filter('a', 2, true), filter('b', 1, true)]);

        expect(readFilters(db).map((entry) => entry.id)).toEqual(['b', 'a']);
    });

    it('remembers which rules the user already accepted', () => {
        // Replacing the table naively would un-adopt everything, and every rule would come back as
        // "found in Proton, please confirm" — which teaches people to click through it.
        mirrorFilters(db, [filter('a', 1, true)]);
        db.prepare('UPDATE filters SET adopted = 1 WHERE id = ?').run('a');

        mirrorFilters(db, [filter('a', 1, true), filter('b', 2, true)]);

        const [first, second] = readFilters(db);
        expect(first?.adopted).toBe(true);
        expect(second?.adopted).toBe(false);
    });

    it('marks a filter with no Simple form as authored in Sieve', () => {
        mirrorFilters(db, [filter('a', 1, false)]);

        expect(readFilters(db)[0]?.authoredAs).toBe('sieve');
    });
});

describe('mirroring messages', () => {
    it('moves a message rather than filing it in two places', () => {
        // The failure that would quietly corrupt every count: merging labels instead of replacing.
        mirrorMessages(db, [message('m1', ['inbox'])]);
        mirrorMessages(db, [message('m1', ['archiv'])]);

        expect(readMessages(db, { labelId: 'inbox' })).toEqual([]);
        expect(readMessages(db, { labelId: 'archiv' }).map((entry) => entry.id)).toEqual(['m1']);
    });

    it('updates a message instead of duplicating it', () => {
        mirrorMessages(db, [message('m1', ['inbox'])]);
        mirrorMessages(db, [{ ...message('m1', ['inbox']), Subject: 'Geändert' }]);

        const stored = readMessages(db);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.subject).toBe('Geändert');
    });

    it('returns newest first, because that is what every screen shows', () => {
        mirrorMessages(db, [message('alt', ['inbox'], 1_000), message('neu', ['inbox'], 2_000)]);

        expect(readMessages(db).map((entry) => entry.id)).toEqual(['neu', 'alt']);
    });

    it('carries the labels along, so membership needs no second query', () => {
        mirrorMessages(db, [message('m1', ['inbox', 'wichtig'])]);

        expect(readMessages(db)[0]?.labelIds.sort()).toEqual(['inbox', 'wichtig']);
    });

    it('replaces recipients too, not just labels', () => {
        mirrorMessages(db, [{ ...message('m1', ['inbox']), CCList: [{ Address: 'wer@beispiel.example' }] }]);
        mirrorMessages(db, [message('m1', ['inbox'])]);

        const count = db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE kind = ?').get('cc') as {
            n: number;
        };
        expect(count.n).toBe(0);
    });

    it('removes the labels of a message when the message goes', () => {
        mirrorMessages(db, [message('m1', ['inbox'])]);
        db.prepare('DELETE FROM messages WHERE id = ?').run('m1');

        const count = db.prepare('SELECT COUNT(*) AS n FROM message_labels').get() as { n: number };
        expect(count.n).toBe(0);
    });
});

/**
 * Which rules the tool considers its own.
 *
 * A filter that turns up at Proton without this tool writing it is not automatically part of the set
 * the dashboard manages — the „Änderungen" screen asks about it first. That whole screen was empty
 * against a real account because nothing ever marked a filter unadopted, and a rule written in
 * Proton's own interface simply joined the list as though it had always been there.
 *
 * The first mirror is the exception and adopts everything: a brand new copy has no history to
 * compare against, and calling somebody's entire existing rule set "unexpected" would teach them to
 * dismiss the screen on their first day.
 */
describe('rules that appeared without us', () => {
    it('adopts everything on the first mirror, because there is nothing to be surprised by', () => {
        mirrorFilters(db, [filter('f-1', 1, true), filter('f-2', 2, true)]);

        expect(readFilters(db).map((entry) => entry.adopted)).toEqual([true, true]);
    });

    it('marks a filter that showed up afterwards as not yet adopted', () => {
        mirrorFilters(db, [filter('f-1', 1, true)]);
        mirrorFilters(db, [filter('f-1', 1, true), filter('f-2', 2, true)]);

        const byId = new Map(readFilters(db).map((entry) => [entry.id, entry.adopted]));
        expect(byId.get('f-1')).toBe(true);
        expect(byId.get('f-2')).toBe(false);
    });

    it('keeps an adoption across the next mirror, so the question is asked once', () => {
        mirrorFilters(db, [filter('f-1', 1, true)]);
        mirrorFilters(db, [filter('f-1', 1, true), filter('f-2', 2, true)]);

        expect(markAdopted(db, ['f-2'])).toBe(1);
        mirrorFilters(db, [filter('f-1', 1, true), filter('f-2', 2, true)]);

        expect(readFilters(db).every((entry) => entry.adopted)).toBe(true);
    });
});
