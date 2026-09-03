import { execFile } from 'node:child_process';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { getLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const log = getLogger('private-file');

/**
 * Write a file only its owner should read.
 *
 * The mistake worth naming: `writeFile(path, data, { mode })` applies the mode when the file is
 * *created* and ignores it when the file already exists. A file that was ever loose stays loose
 * through every rewrite — and these are session tokens, a login-attempt record, and a backup of
 * someone's filters. `chmod` afterwards is what actually enforces it.
 *
 * `chmod` means nothing on Windows, where it toggles a read-only flag and there is no owner bit.
 * The equivalent there is an ACL change, which this attempts — and which it does **not** treat as
 * load-bearing.
 *
 * That last part is deliberate. What this defends against is another *user account* on the same
 * machine reading the file. On a single-user laptop that is close to nothing, and an administrator
 * can read it either way. Failing the whole program because a hardening step did not apply would
 * trade a real capability for a theoretical one. So it warns and carries on.
 */

const OWNER_ONLY = 0o600;

export async function writePrivateFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { encoding: 'utf8', mode: OWNER_ONLY });
    await restrictToOwner(path);
}

/** Take away other accounts' access. Best effort on Windows, enforced elsewhere. */
export async function restrictToOwner(path: string): Promise<void> {
    if (process.platform !== 'win32') {
        await chmod(path, OWNER_ONLY);
        return;
    }

    // `/inheritance:r` drops what the folder handed down; without it the local Users group usually
    // keeps read access and granting ourselves anything changes nothing. SYSTEM and Administrators
    // are left alone on purpose — removing them breaks backup and recovery, and an administrator
    // can read the file regardless.
    const { username } = userInfo();
    const domain = process.env['USERDOMAIN'];
    const account = domain === undefined || domain === '' ? username : `${domain}\\${username}`;

    try {
        await execFileAsync(
            'icacls',
            [path, '/inheritance:r', '/grant:r', `${account}:F`, '/grant:r', '*S-1-5-32-544:F'],
            { windowsHide: true }
        );
    } catch (cause) {
        // Not fatal. Say so once, in the log, with whatever icacls gave as a reason.
        const detail = String((cause as { stderr?: string }).stderr ?? '')
            .split(/\r?\n/)
            .find((line) => line.trim() !== '');
        log.warn({ path, detail }, 'could not restrict file permissions; leaving them as they are');
    }
}

/**
 * Whether a file is restricted to its owner, where that question has an answer.
 *
 * `undefined` on Windows, and that is the honest return rather than a guess. Permissions there are
 * an ACL, the `icacls` output is localised, and the well-known accounts that legitimately appear in
 * it vary by machine. Returning `true` because a command exited zero would be a check that always
 * passes, which is worse than admitting there is none.
 */
export async function isOwnerOnly(path: string): Promise<boolean | undefined> {
    if (process.platform === 'win32') {
        return undefined;
    }
    return ((await stat(path)).mode & 0o777) === OWNER_ONLY;
}

/** What the system reports, for a failure message. */
export async function describeOwnership(path: string): Promise<string> {
    try {
        if (process.platform === 'win32') {
            return 'Windows: Rechte liegen in ACLs, hier nicht geprüft';
        }
        return `mode ${((await stat(path)).mode & 0o777).toString(8)}`;
    } catch (error) {
        return `nicht feststellbar: ${String(error)}`;
    }
}
