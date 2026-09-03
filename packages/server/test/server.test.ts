import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageMetadata, ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { mirrorFilters, mirrorLabels, mirrorMessages, setMeta } from '@pms/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { route } from '../src/handler.js';
import { serveMailbox } from '../src/serve.js';
import { buildSnapshot } from '../src/snapshot.js';

/**
 * The local server, which exists to hand the dashboard a mailbox it cannot open itself.
 *
 * Two things are worth testing and one of them is the whole point. The snapshot has to be faithful,
 * including about what it could *not* read — a filter silently dropped here becomes a conflict
 * analysis that is wrong in the user's favour, which is the most expensive kind of wrong this
 * project can be. And the server has to be incapable of writing: not "has no write routes today"
 * but refusing every method that is not GET, before it looks at the path at all.
 */

const PASSPHRASE = 'test-passphrase-not-a-real-one';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-server-'));
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

/** A filter with a Simple form — the kind Proton's own interface can still edit. */
function simpleFilter(id: string, destination: string): ProtonFilter {
    return {
        ID: id,
        Name: `Regel ${id}`,
        Status: 1,
        Priority: 1,
        Version: 2,
        Sieve: 'keep;',
        Tree: [{ Type: 'Require' }],
        Simple: {
            Operator: { value: 'all', label: 'All' },
            Conditions: [],
            Actions: { FileInto: [destination], Mark: { Read: false, Starred: false } },
        },
    };
}

describe('the mailbox snapshot', () => {
    it('carries the folders, rules and messages the copy holds', () => {
        mirrorLabels(db, { folders: [folder('f-1', 'Rechnungen'), folder('f-2', 'Bahn', 'f-1')], labels: [] });
        mirrorFilters(db, [simpleFilter('r-1', 'Rechnungen')]);
        mirrorMessages(db, [message('m-1', ['0']), message('m-2', ['f-1'])]);

        const snapshot = buildSnapshot(db);

        expect(snapshot.folders.map((entry) => entry.Name)).toEqual(['Rechnungen', 'Bahn']);
        expect(snapshot.folders[1]?.ParentID).toBe('f-1');
        expect(snapshot.rules).toHaveLength(1);
        expect(snapshot.rules[0]?.rule.Actions.FileInto).toEqual(['Rechnungen']);
        expect(snapshot.messages).toHaveLength(2);
        expect(snapshot.meta.source).toBe('proton');
    });

    it('reports a filter it could not read instead of dropping it', () => {
        // The filter still runs at Proton whatever we make of it. A screen that omits it is showing
        // a mailbox that does not exist, and every rule conflict computed from that list is wrong.
        const broken: ProtonFilter = {
            ID: 'r-broken',
            Name: 'Unlesbar',
            Status: 1,
            Priority: 2,
            Version: 2,
            Sieve: 'keep;',
            Tree: [{ Type: 'Nonsense', Nested: { nothing: true } }],
        };
        mirrorFilters(db, [simpleFilter('r-1', 'Archiv'), broken]);

        const snapshot = buildSnapshot(db);

        expect(snapshot.rules.map((entry) => entry.id)).toEqual(['r-1']);
        expect(snapshot.unreadable.map((entry) => entry.id)).toEqual(['r-broken']);
        expect(snapshot.unreadable[0]?.name).toBe('Unlesbar');
    });

    it('flags a folder that duplicates one of Proton’s own', () => {
        // An IMAP migration leftover. A rule filing into "Junk" puts mail somewhere the user never
        // looks, while Proton's own Spam folder sits next to it.
        mirrorLabels(db, { folders: [folder('f-1', 'Junk'), folder('f-2', 'Rechnungen')], labels: [] });

        const snapshot = buildSnapshot(db);

        expect(snapshot.folders[0]?.shadowsSystemFolder).toBe('Spam');
        expect(snapshot.folders[1]?.shadowsSystemFolder).toBeUndefined();
    });

    it('says when the copy is known to be incomplete', () => {
        setMeta(db, 'lastSyncTruncated', '1');
        setMeta(db, 'lastSyncAt', '1700000000');

        const snapshot = buildSnapshot(db);

        expect(snapshot.meta.truncated).toBe(true);
        expect(snapshot.meta.syncedAt).toBe(1_700_000_000);
    });

    it('has no sync time before the first sync finishes, rather than pretending to one', () => {
        expect(buildSnapshot(db).meta.syncedAt).toBeUndefined();
    });
});

describe('the server refuses to write', () => {
    // Not "there is no write route" — that is true of any server until someone adds one. The method
    // is rejected before the path is looked at, so there is no route table a write could join.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('answers 405 to %s', (method) => {
        const reply = route(method, '/api/mailbox', db);

        expect(reply.status).toBe(405);
    });

    it('answers 405 to a write even on a path that does not exist', () => {
        expect(route('POST', '/api/anything', db).status).toBe(405);
    });

    it('still serves a GET', () => {
        expect(route('GET', '/api/health', db)).toEqual({ status: 200, body: { ok: true } });
    });

    it('answers 404 to an unknown path', () => {
        expect(route('GET', '/api/nope', db).status).toBe(404);
    });
});

describe('the running server', () => {
    it('serves the snapshot over loopback and stops cleanly', async () => {
        mirrorLabels(db, { folders: [folder('f-1', 'Rechnungen')], labels: [] });
        const server = await serveMailbox({ db, port: 0 });

        try {
            const response = await fetch(`${server.url}/api/mailbox`);
            const body = (await response.json()) as { folders: Array<{ Name: string }> };

            expect(response.status).toBe(200);
            // The mailbox must not be cached anywhere on its way to the browser.
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(body.folders.map((entry) => entry.Name)).toEqual(['Rechnungen']);
        } finally {
            await server.close();
        }
    });

    it('binds the loopback interface only', async () => {
        const server = await serveMailbox({ db, port: 0 });

        try {
            // The database is open in this process; anything that can reach the port can read the
            // mailbox. That is acceptable for this machine and for nothing else.
            expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
        } finally {
            await server.close();
        }
    });
});
