import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isAppError } from '@pms/core/errors';
import { configureLogging, getLogger } from '@pms/core/logger';
import {
    countMessagesInRange,
    getFilters,
    getFolders,
    getLabels,
    getMessageCounts,
    getMessages,
} from '@pms/proton-api';

import { credentialConfig } from './credentials.js';
import { FIXTURE_DIR, loadEnvFile } from './paths.js';
import { terminal } from './prompt.js';
import { scrub, SCRUB_NOTE } from './scrub.js';
import { connect } from './session.js';
import { describeItem } from '@pms/credentials';

/**
 * M0 read-only spike.
 *
 * Purpose: prove against the real API — before a single line of the tool is designed around it —
 * that the SRP login works, that our headers are accepted, that the schemas match, and what the
 * `Tree` of a real filter actually looks like. Then record scrubbed fixtures so the rest of the
 * project can be built and tested offline.
 *
 * This program performs GET requests only, plus the POSTs that constitute the login handshake. It
 * cannot modify the account: nothing in `@pms/proton-api` can write yet.
 */



const log = getLogger('spike');

interface Recorded {
    name: string;
    endpoint: string;
    data: unknown;
}

/**
 * Print the field labels of the configured 1Password item — labels only, never values.
 *
 * When the item is not laid out the way the code expects, the useful question is "what are the
 * fields called", and answering it must never require anyone to reveal a password.
 */
async function describeCredentialItem(): Promise<void> {
    const config = credentialConfig();
    if (config.vault === undefined || config.vault === '') {
        console.log('PMS_OP_VAULT ist nicht gesetzt — es gibt nichts zu beschreiben.');
        console.log('Beispiel: PMS_OP_VAULT="Kevin Private" PMS_OP_ITEM="Proton" pnpm spike --describe-1password\n');
        return;
    }

    const labels = await describeItem({ vault: config.vault, item: config.item });
    console.log(`\nFelder in "${config.item}" (Tresor "${config.vault}") — nur Namen, keine Werte:\n`);
    for (const label of labels) {
        console.log(`  ${label}`);
    }
    console.log('\nErwartet werden "username" (oder "email") und "password".');
    console.log('Heissen sie anders, sag mir die Namen — die Werte brauche ich nicht.\n');
}

async function main(): Promise<void> {
    loadEnvFile();
    configureLogging({ level: (process.env['LOG_LEVEL'] as 'info') ?? 'info' });

    if (process.argv.includes('--describe-1password')) {
        await describeCredentialItem();
        return;
    }

    console.log('\nProton Mail Sorter — M0 Spike (nur lesend)\n');
    console.log('Es werden ausschliesslich Daten gelesen. Am Konto wird nichts verändert.');
    console.log('Proton-Passwort und 2FA-Code werden nirgends gespeichert.\n');

    const { http } = await connect();

    const recorded: Recorded[] = [];

    // ---------------------------------------------------------------- folders and labels
    const folders = await getFolders(http);
    const labels = await getLabels(http);
    recorded.push({ name: 'labels-folders', endpoint: 'GET core/v4/labels?Type=3', data: folders });
    recorded.push({ name: 'labels-labels', endpoint: 'GET core/v4/labels?Type=1', data: labels });

    const topLevel = folders.filter((f) => f.ParentID === undefined || f.ParentID === null || f.ParentID === '');
    console.log(`Ordner:  ${folders.length} (davon ${topLevel.length} auf oberster Ebene)`);
    console.log(`Labels:  ${labels.length}`);

    // ---------------------------------------------------------------- filters
    const filters = await getFilters(http);
    recorded.push({ name: 'filters', endpoint: 'GET mail/v4/filters', data: filters });

    const treeFilters = filters.filter((f) => f.Simple !== undefined);
    const sieveOnly = filters.filter((f) => f.Simple === undefined);
    const enabled = filters.filter((f) => f.Status === 1);
    console.log(
        `Filter:  ${filters.length} (${enabled.length} aktiv, ${treeFilters.length} in der Proton-UI editierbar, ` +
            `${sieveOnly.length} nur als Sieve)`
    );

    // ---------------------------------------------------------------- message volume
    const counts = await getMessageCounts(http);
    recorded.push({ name: 'message-counts', endpoint: 'GET mail/v4/messages/count', data: counts });

    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    console.log('\nMailmenge nach Zeitraum:');
    for (const [label, days] of [
        ['30 Tage', 30],
        ['90 Tage', 90],
        ['1 Jahr', 365],
    ] as const) {
        const total = await countMessagesInRange(http, { begin: now - days * day });
        console.log(`  ${label.padEnd(8)} ${String(total).padStart(7)} Mails`);
    }
    const all = await countMessagesInRange(http);
    console.log(`  ${'alles'.padEnd(8)} ${String(all).padStart(7)} Mails`);

    // A single page, to confirm the metadata schema against real messages.
    const page = await getMessages(http, { pageSize: 20 });
    recorded.push({ name: 'messages-page', endpoint: 'GET mail/v4/messages', data: page.messages });

    // ---------------------------------------------------------------- write fixtures
    await mkdir(FIXTURE_DIR, { recursive: true });
    for (const entry of recorded) {
        const file = join(FIXTURE_DIR, `${entry.name}.json`);
        await writeFile(
            file,
            `${JSON.stringify({ _endpoint: entry.endpoint, _note: SCRUB_NOTE, data: scrub(entry.data) }, null, 2)}\n`,
            'utf8'
        );
    }
    console.log(`\n✓ ${recorded.length} Fixtures geschrieben nach fixtures/recorded/ (pseudonymisiert).`);
    console.log('  Bitte einmal durchsehen, bevor sie committet werden.\n');

    log.info(
        { folders: folders.length, labels: labels.length, filters: filters.length, messages: all },
        'spike complete'
    );
}

main()
    .catch((error: unknown) => {
        console.error('\n✗ Abgebrochen.\n');
        if (isAppError(error)) {
            console.error(`  [${error.code}] ${error.message}`);
            if (error.hint !== undefined) {
                console.error(`  → ${error.hint}`);
            }
            if (Object.keys(error.context).length > 0) {
                console.error(`  Kontext: ${JSON.stringify(error.context)}`);
            }
        } else if (error instanceof Error) {
            console.error(`  ${error.message}`);
        } else {
            console.error(error);
        }
        console.error('');
        process.exitCode = 1;
    })
    .finally(() => {
        // The stdin listener keeps the process alive otherwise.
        terminal.close();
    });
