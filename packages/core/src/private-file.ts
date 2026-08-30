import { execFile } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { AppError } from './errors.js';

const execFileAsync = promisify(execFile);

/**
 * Write a file only its owner may read.
 *
 * Two mistakes are worth naming, because both look like they work.
 *
 * `writeFile(path, data, { mode })` applies the mode when the file is *created* and ignores it when
 * the file already exists. A file that was ever loose stays loose through every rewrite — and the
 * files this is for are session tokens, a login-attempt record, and a backup of someone's filters.
 *
 * And `chmod` is not portable. On Windows it toggles a read-only flag and nothing else: there is no
 * owner bit to set, so a program that calls it and moves on has done nothing while appearing
 * careful. Windows keeps permissions in ACLs, which is a different call entirely.
 *
 * So: chmod where that means something, `icacls` where it does not.
 */

const OWNER_ONLY = 0o600;

export async function writePrivateFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { encoding: 'utf8', mode: OWNER_ONLY });
    await restrictToOwner(path);
}

/**
 * Take away everyone else's access to a file that already exists.
 *
 * Separate from the write so it can be applied to files created before this existed, and so the
 * check below can be written against the same notion of "restricted".
 */
export async function restrictToOwner(path: string): Promise<void> {
    if (process.platform !== 'win32') {
        await chmod(path, OWNER_ONLY);
        return;
    }

    // `/inheritance:r` drops the entries the folder handed down — without it, "Users" often still
    // has read access and granting ourselves full control changes nothing. `/grant:r` replaces any
    // existing entry for this account rather than adding a second one.
    const account = windowsAccount();
    try {
        await execFileAsync('icacls', [path, '/inheritance:r', '/grant:r', `${account}:F`], {
            windowsHide: true,
        });
    } catch (cause) {
        // icacls says why on stderr, and the reason is usually specific: an unknown trustee name, a
        // path it cannot see. Passing it through beats "the call failed".
        const detail = String((cause as { stderr?: string }).stderr ?? '')
            .split(/\r?\n/)
            .find((line) => line.trim() !== '');

        throw new AppError('VAULT_KEY_REJECTED', {
            message: `Die Zugriffsrechte auf \`${path}\` liessen sich nicht einschränken.`,
            hint:
                'Unter Windows setzt `icacls` die Rechte, und der Aufruf ist fehlgeschlagen — die ' +
                'Datei ist also möglicherweise für andere Konten dieses Rechners lesbar.' +
                (detail === undefined ? '' : ` icacls meldet: ${detail}`) +
                ` Nachsehen mit: icacls "${path}"`,
            context: { path, account, icacls: detail },
            cause,
        });
    }
}

/**
 * Whether a file is restricted to its owner.
 *
 * Exists so the tests can ask the question in a way that means the same thing on both systems. A
 * test asserting `mode === 0o600` silently passes nothing on Windows, where the mode is whatever
 * Node makes up from the read-only flag.
 */
export async function isOwnerOnly(path: string): Promise<boolean> {
    if (process.platform !== 'win32') {
        return ((await stat(path)).mode & 0o777) === OWNER_ONLY;
    }

    const trustees = await windowsTrustees(path);
    const account = windowsAccount().toLowerCase();

    return trustees.length > 0 && trustees.every((trustee) => trustee.toLowerCase() === account);
}

/**
 * Who icacls says has access, by name.
 *
 * Parsed by looking for `NAME:(` rather than by counting lines, because icacls output is localised
 * — a German Windows prints different headings and a different summary line, and the first version
 * of this counted two trailing lines and hoped. The `:(` is the one part that is punctuation rather
 * than language. A drive letter cannot be mistaken for a trustee: `C:\` is a colon and a backslash.
 */
async function windowsTrustees(path: string): Promise<string[]> {
    const { stdout } = await execFileAsync('icacls', [path], { windowsHide: true });
    return [...stdout.matchAll(/(\S+):\(/g)].map((match) => match[1] ?? '');
}

/**
 * What the system reports about a file, verbatim.
 *
 * For failure messages. "expected false to be true" is not something anyone can act on, and the
 * evidence that would explain it is one command away.
 */
export async function describeOwnership(path: string): Promise<string> {
    try {
        if (process.platform !== 'win32') {
            return `mode ${((await stat(path)).mode & 0o777).toString(8)}`;
        }
        const { stdout } = await execFileAsync('icacls', [path], { windowsHide: true });
        return `icacls:\n${stdout.trim()}\n(erwartetes Konto: ${windowsAccount()})`;
    } catch (error) {
        return `nicht feststellbar: ${String(error)}`;
    }
}

/** `DOMAIN\user`, which is what icacls wants; a plain username fails on a domain-joined machine. */
function windowsAccount(): string {
    const { username } = userInfo();
    const domain = process.env['USERDOMAIN'];
    return domain === undefined || domain === '' ? username : `${domain}\\${username}`;
}
