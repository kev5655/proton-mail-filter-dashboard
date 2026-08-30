import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSession, saveSession, type StoredSession } from '../src/session-store.js';

/**
 * The session store exists so the tool logs in once instead of on every run — the behaviour that
 * got the test account locked. These tests cover the two things that make it worth having: the
 * tokens are unreadable without the passphrase, and a stored session actually survives a restart.
 */

let dir: string;
let path: string;

const SESSION: StoredSession = {
    session: {
        uid: 'uid-abcdef123456',
        accessToken: 'access-token-do-not-leak',
        refreshToken: 'refresh-token-do-not-leak',
    },
    userId: 'user-42',
    createdAt: 1_800_000_000,
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pms-session-'));
    path = join(dir, 'session.json');
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('session store', () => {
    it('round-trips a session', async () => {
        await saveSession(path, SESSION, 'correct horse battery staple');
        expect(await loadSession(path, 'correct horse battery staple')).toEqual(SESSION);
    });

    it('writes no token in the clear', async () => {
        await saveSession(path, SESSION, 'passphrase');
        const raw = await readFile(path, 'utf8');

        expect(raw).not.toContain('access-token-do-not-leak');
        expect(raw).not.toContain('refresh-token-do-not-leak');
        expect(raw).not.toContain('uid-abcdef123456');
        expect(raw).not.toContain('user-42');
    });

    it('refuses the wrong passphrase instead of returning nonsense', async () => {
        await saveSession(path, SESSION, 'right');
        await expect(loadSession(path, 'wrong')).rejects.toThrow(/entschlüsseln/);
    });

    it('detects tampering, because a modified token is not merely unreadable but dangerous', async () => {
        await saveSession(path, SESSION, 'passphrase');
        const envelope = JSON.parse(await readFile(path, 'utf8')) as { ciphertext: string };
        const bytes = Buffer.from(envelope.ciphertext, 'base64');
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        await saveTampered(path, { ...envelope, ciphertext: bytes.toString('base64') });

        await expect(loadSession(path, 'passphrase')).rejects.toThrow(/entschlüsseln/);
    });

    it('returns undefined when nothing is stored yet, rather than throwing', async () => {
        expect(await loadSession(join(dir, 'absent.json'), 'passphrase')).toBeUndefined();
    });

    it.skipIf(process.platform === 'win32')('keeps the file readable only by its owner', async () => {
        // Deliberately starting from a loose file. Writing a fresh one and checking the mode passes
        // even with `writeFile`'s `mode` option, which does nothing when the file already exists —
        // so the tokens of anyone whose file was once world-readable stayed that way. This test
        // only caught it by accident, on a run where an earlier case had created the file first.
        await writeFile(path, '{}');
        await chmod(path, 0o666);

        await saveSession(path, SESSION, 'passphrase');

        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it('uses a fresh salt and iv per write, so two saves never look alike', async () => {
        await saveSession(path, SESSION, 'passphrase');
        const first = await readFile(path, 'utf8');
        await saveSession(path, SESSION, 'passphrase');
        const second = await readFile(path, 'utf8');

        expect(first).not.toBe(second);
    });

    it('rejects a file from a future format instead of guessing at it', async () => {
        await saveSession(path, SESSION, 'passphrase');
        const envelope = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        await saveTampered(path, { ...envelope, version: 99 });

        await expect(loadSession(path, 'passphrase')).rejects.toThrow(/Format 99/);
    });
});

async function saveTampered(target: string, envelope: unknown): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(target, JSON.stringify(envelope), 'utf8');
}
