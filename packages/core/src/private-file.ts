import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a file only its owner may read.
 *
 * `writeFile(path, data, { mode })` looks like it does this and does not: the mode is applied when
 * the file is *created* and ignored when it already exists. So a file that ever existed with loose
 * permissions keeps them forever, however many times it is rewritten — and the one place that
 * matters is exactly the kind of file this is used for: session tokens, a login-attempt record, a
 * backup of someone's filters.
 *
 * It also gets masked by the process umask, so `0o600` is a request rather than a result.
 *
 * `chmod` afterwards is neither, and it is what this does. The write and the chmod are not atomic;
 * that window is accepted, because the alternative — write to a fresh temp file and rename — trades
 * it for a different one and does not remove it either.
 *
 * Callers should not pass a `mode` to `writeFile` themselves. Use this.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
    // The line that actually enforces it, on a new file and an existing one alike.
    await chmod(path, 0o600);
}
