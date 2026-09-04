import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageMetadata, ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { mirrorFilters, mirrorLabels, mirrorMessages, setMeta } from '@pms/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApplyChannel } from '../src/apply-channel.js';
import { LoginChannel } from '../src/login-channel.js';
import { route } from '../src/handler.js';
import { isUsableInterval, SyncChannel } from '../src/sync-channel.js';
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
    // Every method that is not GET is rejected, and the single exception is named rather than
    // being an entry in a table anyone could extend.
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('answers 405 to %s', (method) => {
        const reply = route(method, '/api/mailbox', db);

        expect(reply.status).toBe(405);
    });

    it('answers 405 to a write even on a path that does not exist', () => {
        expect(route('POST', '/api/anything', db).status).toBe(405);
    });

    it('accepts exactly three non-GET paths, and only those', () => {
        // If this list ever grows, it should be because someone meant it to — which is why it is a
        // list rather than a rule. Each of the three is named in CLAUDE.md with its own reason:
        // `/api/apply` records an offer and writes nothing yet, `/api/sync` only reads at Proton,
        // and `/api/login` opens a browser window that this process never types into.
        const paths = [
            '/api/sync',
            '/api/apply',
            '/api/login',
            '/api/mailbox',
            '/api/health',
            '/api/anything',
            '/api/rules',
        ];
        const accepted = paths.filter(
            (path) =>
                route('POST', path, db, {
                    sync: new SyncChannel(async () => summary()),
                    login: new LoginChannel(async () => undefined),
                }).status !== 405
        );

        // All three are *recognised* — `/api/apply` answers 503 here because no apply channel was
        // given, which is a different answer from „this server does not write". Everything else is
        // refused before the path is even looked at.
        expect(accepted).toEqual(['/api/sync', '/api/apply', '/api/login']);
    });

    it('refuses a login when the server has no way to open one', () => {
        expect(route('POST', '/api/login', db).status).toBe(503);
    });

    it('refuses a second login while a window is already open', () => {
        // One window at a time. Two would race for the same session file — and a second window is
        // also a second attempt, which is the thing `LoginGuard` exists to ration.
        const login = new LoginChannel(async () => new Promise(() => undefined));

        expect(route('POST', '/api/login', db, { login }).status).toBe(202);
        expect(route('POST', '/api/login', db, { login }).status).toBe(409);
    });

    it('refuses a sync when the server has no way to reach Proton', () => {
        const reply = route('POST', '/api/sync', db);

        expect(reply.status).toBe(503);
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


/** A sync that reports nothing and finishes immediately. */
function summary(): { labels: number; filters: number; messages: number; truncated: boolean } {
    return { labels: 0, filters: 0, messages: 0, truncated: false };
}

describe('the sync channel', () => {
    it('reports idle before anything happens', () => {
        expect(new SyncChannel(async () => summary()).state).toEqual({ state: 'idle' });
    });

    it('says it cannot sync when no runner was given', () => {
        const channel = new SyncChannel();

        expect(channel.available).toBe(false);
        expect(channel.start()).toContain('keine Verbindung');
    });

    it('runs one at a time, and says so rather than queueing', async () => {
        // Two concurrent syncs would double the request rate against Proton — the pacing in
        // ProtonHttp is per client, not global — and both would write the same tables.
        let release = (): void => {};
        const channel = new SyncChannel(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return summary();
        });

        expect(channel.start()).toBeUndefined();
        expect(channel.start()).toContain('bereits');

        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(channel.state.state).toBe('done');
    });

    it('passes progress through to subscribers', async () => {
        const seen: Array<string | undefined> = [];
        const channel = new SyncChannel(async (report) => {
            report({ stage: 'labels', done: 3, total: 3 });
            report({ stage: 'messages', done: 100 });
            return summary();
        });

        channel.subscribe((state) => {
            seen.push(state.state === 'running' ? state.progress?.stage : state.state);
        });
        channel.start();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(seen).toContain('labels');
        expect(seen).toContain('messages');
        expect(seen.at(-1)).toBe('done');
    });

    it('reports a failure instead of leaving the state running', async () => {
        const channel = new SyncChannel(async () => {
            throw new Error('Proton nicht erreichbar');
        });

        channel.start();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(channel.state.state).toBe('failed');
        expect(channel.state).toMatchObject({ error: 'Proton nicht erreichbar' });
    });
});


/**
 * What the `202` tells the dashboard, and why one field of it matters.
 *
 * Most changes are confirmed once, in the diff dialog. Only the expensive ones — a deletion, a
 * change that moves mail, one that resorts a large share of the mailbox — are asked about again in
 * the terminal. The interface used to announce that second question for every change and then not
 * ask it, which is the fastest way to teach somebody that a sentence on screen is not worth
 * reading.
 *
 * The rule that decides lives in `@pms/apply`, which the dashboard may not import — it drags the
 * Proton client into the browser bundle, and `write-isolation.test.ts` exists to keep it out. So the
 * answer travels in the response instead of being worked out twice.
 */
describe('the offer answers whether a terminal question is coming', () => {
    function channel(needsTerminal: boolean, reason = ''): ApplyChannel {
        return new ApplyChannel(
            (request) => ({
                id: (request as { requestId: string }).requestId,
                summary: 'Eine Änderung',
                shortDigest: 'ABC-DEF',
                needsTerminal,
                reason,
            }),
            async () => ({ backupPath: '/tmp/backup.json' })
        );
    }

    it('says so, with the reason, when one is', () => {
        const reply = route(
            'POST',
            '/api/apply',
            db,
            { apply: channel(true, 'Diese Änderung löscht etwas.') },
            { requestId: 'req-1' }
        );

        expect(reply.status).toBe(202);
        expect(reply.body).toMatchObject({
            needsTerminal: true,
            reason: 'Diese Änderung löscht etwas.',
            waiting: 'Bestätigung im Terminal',
        });
    });

    it('says so when one is not, and does not promise a wait', () => {
        const reply = route('POST', '/api/apply', db, { apply: channel(false) }, { requestId: 'req-2' });

        expect(reply.status).toBe(202);
        expect(reply.body).toMatchObject({ needsTerminal: false });
        expect(reply.body).not.toHaveProperty('waiting');
    });
});


/**
 * The auto-sync rhythm, carried on the request that already exists.
 *
 * A timer on the machine the user is sitting at does not deserve a third non-GET route — the
 * promise that there are exactly two is a constraint on the design, not an accident — so the
 * interval rides on `POST /api/sync`. What matters is that a value the server will not honour is
 * refused rather than quietly clamped: a number typed by a person and a number chosen by a server
 * should never silently differ.
 */
describe('asking for a different auto-sync interval', () => {
    function channelSeeing(seen: Array<number | undefined>): SyncChannel {
        return new SyncChannel(
            async () => summary(),
            ({ intervalMinutes }) => {
                seen.push(intervalMinutes);
            }
        );
    }

    it('passes a sensible interval through to whoever owns the timer', () => {
        const seen: Array<number | undefined> = [];
        const reply = route('POST', '/api/sync', db, { sync: channelSeeing(seen) }, { intervalMinutes: 15 });

        expect(reply.status).toBe(202);
        expect(seen).toEqual([15]);
    });

    it('treats 0 as off rather than as nonsense', () => {
        const seen: Array<number | undefined> = [];
        const reply = route('POST', '/api/sync', db, { sync: channelSeeing(seen) }, { intervalMinutes: 0 });

        expect(reply.status).toBe(202);
        expect(seen).toEqual([0]);
    });

    it('refuses a nonsensical one, and starts nothing', () => {
        const seen: Array<number | undefined> = [];
        const channel = channelSeeing(seen);
        const reply = route('POST', '/api/sync', db, { sync: channel }, { intervalMinutes: -3 });

        expect(reply.status).toBe(409);
        expect(seen).toEqual([]);
        expect(channel.state.state).toBe('idle');
    });

    it('runs without one, because most syncs are just syncs', () => {
        const seen: Array<number | undefined> = [];
        const reply = route('POST', '/api/sync', db, { sync: channelSeeing(seen) });

        expect(reply.status).toBe(202);
        expect(seen).toEqual([undefined]);
    });

    it.each([
        [0, true],
        [1, true],
        [1440, true],
        [1441, false],
        [-1, false],
        [1.5, false],
        [Number.NaN, false],
    ])('judges %s as %s', (minutes, usable) => {
        expect(isUsableInterval(minutes)).toBe(usable);
    });
});
