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
        throw new AppError('VAULT_KEY_REJECTED', {
            message: `Die Zugriffsrechte auf \`${path}\` liessen sich nicht einschränken.`,
            hint:
                'Unter Windows werden Rechte über `icacls` gesetzt. Der Aufruf ist fehlgeschlagen, ' +
                'die Datei ist also möglicherweise für andere Konten dieses Rechners lesbar. ' +
                'Prüfen mit: icacls "' +
                path +
                '"',
            context: { path, account },
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

    const { stdout } = await execFileAsync('icacls', [path], { windowsHide: true });
    const account = windowsAccount().toLowerCase();

    // Every access-control entry must name this account. icacls prints one per line after the path,
    // then a summary line; anything else with access means the file is not private.
    const entries = stdout
        .split(/\r?\n/)
        .slice(0, -2)
        .map((line) => line.replace(/^.*?[/\\][^:]*?\s+/, '').trim())
        .filter((line) => line !== '');

    return entries.length > 0 && entries.every((entry) => entry.toLowerCase().startsWith(account));
}

/** `DOMAIN\user`, which is what icacls wants; a plain username fails on a domain-joined machine. */
function windowsAccount(): string {
    const { username } = userInfo();
    const domain = process.env['USERDOMAIN'];
    return domain === undefined || domain === '' ? username : `${domain}\\${username}`;
}
