import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MessageMetadata, ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import { weigh, type ChangeRequest } from '@pms/apply';
import { ApplyChannel, serveMailbox, SyncChannel, type RunningServer } from '@pms/server';
import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { mirrorFilters, mirrorLabels, mirrorMessages, setMeta } from '@pms/sync';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

/**
 * The whole thing, running: a real database, the real server, the real dev proxy, a real browser.
 *
 * The tests above this file exist because there are questions the others cannot answer. Three in
 * particular, and each one has already been wrong in this project:
 *
 *  - **Layout.** `css-overflow.test.ts` checks a stylesheet rule. Whether the page actually scrolls
 *    sideways at 1280 pixels is a question only something with a viewport can answer, and it is the
 *    one Kevin sent a screenshot of.
 *  - **The proxy.** Every check of the server so far went through `curl`, straight at its port. That
 *    the browser reaches it through vite — including a stream, which proxies love to buffer — was
 *    never verified from the browser's side.
 *  - **The sandbox.** That a mail body cannot fetch anything is asserted today about strings. Only a
 *    browser enforces a Content-Security-Policy, so only a browser can show that it holds.
 *
 * Everything is torn down per file. Starting a server and a browser costs a second or two, which is
 * the price of testing the thing rather than a model of it.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = join(HERE, '..');

export interface Harness {
    page: Page;
    url: string;
    /** Every request the browser made, so an outbound fetch can be proven absent. */
    requests: string[];
    /** What the terminal was asked to confirm, and what it answered. */
    confirmations: Array<{ summary: string; shortDigest: string; answer: string }>;
    /** Set by tests that want the next confirmation to be refused. */
    setConfirmAnswer: (answer: 'granted' | 'declined' | 'expired') => void;
    /** How many messages the seeded copy holds — the denominator for "how big is this change". */
    mailboxSize: number;
    /** Requests the fake Proton received that would have changed something. */
    protonWrites: () => string[];
    /** Forget them. The harness is shared per file, so a count is otherwise cumulative. */
    resetWrites: () => void;
    close: () => Promise<void>;
}

export interface SeedOptions {
    folders?: ProtonLabel[];
    filters?: ProtonFilter[];
    messages?: MessageMetadata[];
    /** Leave the account unsynced, so the dashboard falls back to the demo mailbox. */
    empty?: boolean;
}

const PASSPHRASE = 'e2e-passphrase-not-a-real-one';

export async function start(options: SeedOptions = {}): Promise<Harness> {
    const directory = await mkdtemp(join(tmpdir(), 'pms-e2e-'));
    const db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });

    if (options.empty !== true) {
        seed(db, options);
    }

    const confirmations: Harness['confirmations'] = [];
    let answer: 'granted' | 'declined' | 'expired' = 'granted';
    const protonCalls: string[] = [];
    const accountVersion = options.empty === true ? '' : 'e2e-v1';
    const mailboxSize = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

    const apply = new ApplyChannel(
        (request) => {
            const parsed = request as { requestId?: string; change?: { summary?: string } };
            return typeof parsed.requestId === 'string'
                ? {
                      id: parsed.requestId,
                      summary: parsed.change?.summary ?? '?',
                      shortDigest: 'E2E-001',
                  }
                : undefined;
        },
        async (request) => {
            const parsed = request as ChangeRequest;

            /*
             * The real staleness check, not a stand-in.
             *
             * This is the rule that refused every change against a mailbox copy made before the
             * fingerprint existed, and a harness that skipped it would have let that pass.
             */
            if (parsed.baseVersion === '') {
                throw Object.assign(
                    new Error('Die lokale Kopie weiss nicht, wie das Konto aussah, als sie gemacht wurde.'),
                    { code: 'APPLY_STATE_STALE' }
                );
            }
            if (parsed.baseVersion !== accountVersion) {
                throw Object.assign(new Error('Bei Proton hat sich etwas geändert.'), {
                    code: 'APPLY_STATE_STALE',
                });
            }

            // And the real decision about whether a second question is even asked.
            const weight = weigh(parsed, mailboxSize);
            if (!weight.needsSecond) {
                protonCalls.push(writeFor(parsed));
                return { backupPath: join(directory, 'backups', 'proton-e2e.json') };
            }

            confirmations.push({ summary: parsed.change.summary, shortDigest: 'E2E-001', answer });

            if (answer !== 'granted') {
                // Exactly what `applyChange` does when the terminal says no: it throws before any
                // write, and nothing is recorded against the account.
                throw Object.assign(new Error('Die Änderung wurde im Terminal abgelehnt.'), {
                    code: 'APPLY_NOT_CONFIRMED',
                });
            }
            protonCalls.push(writeFor(parsed));
            return { backupPath: join(directory, 'backups', 'proton-e2e.json') };
        }
    );

    const sync = new SyncChannel(async (report) => {
        report({ stage: 'labels', done: 2, total: 2 });
        await pause(80);
        report({ stage: 'messages', done: 100 });
        await pause(80);
        report({ stage: 'messages', done: 200, total: 200 });
        return { labels: 2, filters: 1, messages: 200, truncated: false };
    });

    // Port 0: the operating system picks a free one, so two runs cannot collide.
    const server = await serveMailbox({ db, port: 0, sync, apply });
    process.env['PMS_SERVER_PORT'] = String(server.port);

    const vite = await createServer({
        root: WEB_ROOT,
        configFile: join(WEB_ROOT, 'vite.config.ts'),
        server: { port: 0, strictPort: false },
        logLevel: 'error',
    });
    await vite.listen();

    const address = vite.httpServer?.address();
    const port = address !== null && typeof address === 'object' ? address.port : 5173;
    const url = `http://127.0.0.1:${String(port)}`;

    // `PMS_E2E_HEADED=1` opens a visible window and slows the clicking down, for watching a failing
    // test happen rather than reading about it. The suite is otherwise headless everywhere.
    const headed = process.env['PMS_E2E_HEADED'] === '1';
    const browser = await chromium.launch({ headless: !headed, ...(headed ? { slowMo: 250 } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const requests: string[] = [];
    page.on('request', (request) => {
        requests.push(request.url());
    });

    return {
        page,
        url,
        requests,
        confirmations,
        setConfirmAnswer: (next) => {
            answer = next;
        },
        mailboxSize,
        protonWrites: () => [...protonCalls],
        resetWrites: () => {
            protonCalls.length = 0;
            confirmations.length = 0;
        },
        close: async () => {
            await closeAll(browser, vite, server, db, directory);
        },
    };
}

async function closeAll(
    browser: Browser,
    vite: ViteDevServer,
    server: RunningServer,
    db: Db,
    directory: string
): Promise<void> {
    await browser.close().catch(() => undefined);
    await vite.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
}

/**
 * The request the real write path would make for this change.
 *
 * Kind-aware rather than always "a filter was written", because the bug this suite exists to catch
 * was precisely a change kind that wrote nothing and reported success. A harness that recorded the
 * same string whatever it was handed would have passed straight through it.
 */
function writeFor(request: ChangeRequest): string {
    switch (request.change.kind) {
        case 'create-folder':
            return 'POST core/v4/labels';
        case 'rename-folder':
            return 'PUT core/v4/labels';
        case 'delete-folder':
            return 'DELETE core/v4/labels';
        case 'delete-rule':
            return 'DELETE mail/v4/filters';
        case 'adopt-rule':
            // Adoption is the one kind that reaches Proton with nothing at all.
            return 'none';
        default:
            return 'POST mail/v4/filters';
    }
}

function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A small mailbox with the awkward parts kept.
 *
 * One folder shadowing a Proton system folder, one very long subject, and a sender whose address is
 * long enough to widen a row — the layout tests need something that would overflow if the CSS were
 * wrong, or they would pass against a page with nothing in it.
 */
function seed(db: Db, options: SeedOptions): void {
    const folders = options.folders ?? [
        { ID: 'l-1', Name: 'Rechnungen', Path: 'Rechnungen', Type: 3 },
        { ID: 'l-2', Name: 'Junk', Path: 'Junk', Type: 3 },
    ];

    const filters = options.filters ?? [
        {
            ID: 'f-1',
            Name: 'Rechnungen einsortieren',
            Status: 1,
            Priority: 1,
            Version: 2,
            Sieve: 'keep;',
            Tree: [],
            Simple: {
                Operator: { value: 'all', label: 'all' },
                Conditions: [
                    {
                        Type: { value: 'sender', label: 'sender' },
                        Comparator: { value: 'contains', label: 'contains' },
                        Values: ['rechnung'],
                    },
                ],
                Actions: { FileInto: ['Rechnungen'], Mark: { Read: false, Starred: false } },
            },
        },
    ];

    const messages =
        options.messages ??
        Array.from({ length: 24 }, (_, index) => ({
            ID: `m-${String(index)}`,
            Subject:
                index === 0
                    ? 'Ein aussergewöhnlich langer Betreff, der in einer Zeile niemals Platz findet und deshalb die Spalte breiter machen würde, wenn das Layout es zuliesse'
                    : `Rechnung Nr. ${String(1000 + index)}`,
            Sender: {
                Address:
                    index === 1
                        ? 'eine.sehr.lange.absenderadresse.die.auch.breit.macht@rechnung.beispiel.example'
                        : `absender${String(index)}@rechnung.beispiel.example`,
                Name: `Absender ${String(index)}`,
            },
            ToList: [{ Address: 'ich@beispiel.example' }],
            Time: 1_700_000_000 + index,
            LabelIDs: index % 3 === 0 ? ['0', '25'] : ['0'],
            Unread: 0,
        }));

    mirrorLabels(db, { folders, labels: [] });
    mirrorFilters(db, filters);
    mirrorMessages(db, messages);
    setMeta(db, 'lastSyncAt', '1700000000');
    setMeta(db, 'accountVersion', 'e2e-v1');
}
