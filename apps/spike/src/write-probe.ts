import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { backup, ensureFolder, readAccount, removeFolder } from '@pms/apply';
import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

import { DATA_DIR, logFilePath } from './paths.js';
import { connect } from './session.js';

const log = getLogger('write-probe');

/**
 * One deliberate round trip against the real account: create a folder, look for it, delete it.
 *
 * Everything else in this project either reads, or writes only after a change has travelled through
 * the dashboard, a diff and a confirmation. That is the right shape and it is also why the write
 * path was broken for weeks without anyone being able to say *where*: reproducing it meant clicking
 * through four screens, and the failure came back as one line in a dialog.
 *
 * This is the smallest thing that exercises the same code. It uses the real steps — `readAccount`,
 * `backup`, `ensureFolder`, `removeFolder` — rather than issuing its own requests, so a bug in them
 * is a failure here. If this passes and the dashboard still cannot save a rule, the fault is above
 * the write layer, and that is worth knowing before reading any further.
 *
 * The folder it makes is named for what it is, dated, and deleted at the end of the same run. It is
 * created empty and lives for a few seconds, so nothing can be filed into it and nothing can be
 * lost with it. If the deletion fails, the name is printed and the run says so plainly rather than
 * ending on a success line.
 */

const PREFIX = 'PMS-Schreibtest';

export async function runWriteProbe(argv: readonly string[]): Promise<void> {
    const keep = argv.includes('--behalten');
    const name = `${PREFIX} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

    console.log('\nProton Mail Sorter — Schreibtest\n');
    console.log('Dieser Befehl verändert dein Konto. Genau zweimal, und beide Male sichtbar:');
    console.log(`  1. Er legt einen leeren Ordner „${name}" an.`);
    console.log('  2. Er liest die Ordnerliste zurück und prüft, ob er wirklich da ist.');
    console.log(
        keep
            ? '  3. Er lässt ihn stehen (--behalten). Du musst ihn selbst löschen.'
            : '  3. Er löscht ihn wieder und prüft, ob er wirklich weg ist.'
    );
    console.log('\nEs wird keine Mail angefasst. Der Ordner ist leer, solange er existiert.');

    const logFile = logFilePath();
    if (logFile !== undefined) {
        console.log(`\nJede Anfrage steht danach in ${logFile}.`);
    }

    if (!(await askYes('\nStarten? Tippe „ja": '))) {
        console.log('\nAbgebrochen. Es wurde nichts geschrieben.\n');
        return;
    }

    const { http } = await connect();

    // Step 0 — the same backup every other write is preceded by. A probe that skips it would be
    // testing a path the product does not have.
    const before = await readAccount(http);
    const saved = await backup(http, join(DATA_DIR, 'backups'), Date.now());
    console.log(`\n✓ Sicherung: ${saved.path}`);
    console.log(`  Vorher: ${before.folders.length} Ordner, ${before.filters.length} Filter.`);

    if (before.folders.some((folder) => folder.Name === name)) {
        throw new AppError('FOLDER_ALREADY_EXISTS', {
            message: `Es gibt schon einen Ordner „${name}".`,
            hint: 'Den Ordner in Proton löschen und den Test noch einmal starten.',
            context: { name },
        });
    }

    // Step 1 — create.
    const created = await ensureFolder(http, before, name);
    console.log(`\n✓ Angelegt: ${name} (ID ${created.id})`);
    log.info({ id: created.id }, 'probe folder created');

    // Step 2 — read it back. The write returning 200 means Proton accepted the request, not that
    // the folder exists; the whole point of this run is the difference between those two.
    const afterCreate = await readAccount(http);
    const found = afterCreate.folders.find((folder) => folder.ID === created.id);
    if (found === undefined) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: 'Proton hat das Anlegen bestätigt, aber der Ordner steht nicht in der Liste.',
            hint: 'Das ist der Befund, für den dieser Test da ist. Bitte den Logauszug schicken.',
            context: { name, id: created.id, folders: afterCreate.folders.length },
        });
    }
    console.log(`✓ Zurückgelesen: „${found.Name}" steht in der Ordnerliste bei Proton.`);
    console.log('  Jetzt in Proton nachsehen — er müsste dort auftauchen.');

    if (keep) {
        console.log(`\nFertig. Der Ordner „${name}" bleibt stehen; bitte selbst löschen.\n`);
        return;
    }

    // Step 3 — delete, and read back again.
    await pause(1_500);
    await removeFolder(http, afterCreate, name);
    console.log(`\n✓ Gelöscht: ${name}`);

    const afterDelete = await readAccount(http);
    if (afterDelete.folders.some((folder) => folder.ID === created.id)) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: 'Proton hat das Löschen bestätigt, aber der Ordner steht noch in der Liste.',
            hint: `Der Ordner „${name}" ist noch da und muss von Hand entfernt werden.`,
            context: { name, id: created.id },
        });
    }
    console.log('✓ Zurückgelesen: er ist weg.');

    console.log(
        `\nSchreibweg funktioniert: anlegen, prüfen, löschen, prüfen — alle vier Schritte.\n` +
            `Nachher: ${afterDelete.folders.length} Ordner, ${afterDelete.filters.length} Filter — ` +
            `wie vorher.\n`
    );
    log.info({ folders: afterDelete.folders.length }, 'write probe complete');
}

async function askYes(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise<string>((resolve) => {
            rl.question(question, resolve);
        });
        return answer.trim().toLowerCase() === 'ja';
    } finally {
        rl.close();
    }
}

/** Proton lists asynchronously often enough that an immediate re-read can lag by a moment. */
function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
