import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppError, ProtonApiError } from '@pms/core/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatDuration, isAccountLockout, LoginGuard } from '../src/login-guard.js';

/**
 * The guard that exists because Proton locked the test account.
 *
 * A short run of failed logins — one of them with an empty password from a prompt bug — was enough
 * for Proton to answer with code 2028, "unusual activity targeting your account". The account owner
 * paid for that with a temporary lockout. These tests pin the behaviour that keeps it from
 * happening again, especially the part that matters most: after a lockout, do not retry soon.
 */

let dir: string;
let path: string;
let clock: number;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pms-guard-'));
    path = join(dir, 'login-attempts.json');
    clock = 1_800_000_000;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function guard(): LoginGuard {
    return new LoginGuard({ path, now: () => clock });
}

const lockout = new AppError('PROTON_AUTH_FAILED', {
    message: 'locked',
    context: { protonCode: 2028 },
    cause: new ProtonApiError({ endpoint: 'POST core/v4/auth', httpStatus: 422, protonCode: 2028 }),
});

const wrongPassword = new AppError('PROTON_AUTH_WRONG_PASSWORD', {
    message: 'nope',
    context: { protonCode: 8002 },
});

describe('login guard', () => {
    it('allows the first attempt', async () => {
        await expect(guard().assertMayAttempt()).resolves.toBeUndefined();
    });

    it('blocks the next attempt after a failure', async () => {
        const g = guard();
        await g.recordFailure(wrongPassword);

        await expect(g.assertMayAttempt()).rejects.toThrow(/gesperrt/);
    });

    it('allows again once the cooldown has passed', async () => {
        const g = guard();
        await g.recordFailure(wrongPassword);
        clock += 61;

        await expect(g.assertMayAttempt()).resolves.toBeUndefined();
    });

    it('waits longer with each consecutive failure', async () => {
        const g = guard();
        await g.recordFailure(wrongPassword);
        const first = (await g.read())?.retryAfter ?? 0;

        clock += 61;
        await g.recordFailure(wrongPassword);
        const second = (await g.read())?.retryAfter ?? 0;

        expect(second - clock).toBeGreaterThan(first - (clock - 61));
    });

    it('backs off for hours after an account lockout, not minutes', async () => {
        // The failure that actually happened. Retrying into an active lock is what extends it.
        const g = guard();
        await g.recordFailure(lockout);

        clock += 60 * 60; // an hour later
        await expect(g.assertMayAttempt()).rejects.toThrow(/gesperrt/);

        clock += 6 * 60 * 60;
        await expect(g.assertMayAttempt()).resolves.toBeUndefined();
    });

    it('says why, and says that retrying makes it worse', async () => {
        const g = guard();
        await g.recordFailure(lockout);

        await g.assertMayAttempt().then(
            () => expect.unreachable('should be blocked'),
            (error: AppError) => {
                expect(error.hint).toMatch(/verlängert die Sperre/);
                expect(error.hint).toMatch(/mail\.proton\.me/);
                expect(error.hint).toContain('PROTON_AUTH_FAILED');
            }
        );
    });

    it('clears the record on success', async () => {
        const g = guard();
        await g.recordFailure(wrongPassword);
        await g.recordSuccess();

        await expect(g.assertMayAttempt()).resolves.toBeUndefined();
        expect((await g.read())?.consecutiveFailures).toBe(0);
    });

    it('survives a restart, since the point is to persist across runs', async () => {
        await guard().recordFailure(wrongPassword);
        await expect(guard().assertMayAttempt()).rejects.toThrow(/gesperrt/);
    });

    it('records the error code but nothing from inside the error', async () => {
        // The guard file is written on every failure, so anything it copies out of an error is
        // written to disk. It must take the code and nothing else.
        await guard().recordFailure(
            new AppError('PROTON_AUTH_WRONG_PASSWORD', {
                message: 'Passwort hunter2-secret abgelehnt',
                context: { accessToken: 'token-value-do-not-persist' },
            })
        );
        const contents = await readFile(path, 'utf8');

        expect(contents).toContain('PROTON_AUTH_WRONG_PASSWORD');
        expect(contents).not.toContain('hunter2-secret');
        expect(contents).not.toContain('token-value-do-not-persist');
    });
});

describe('isAccountLockout', () => {
    it('recognises Proton code 2028', () => {
        expect(isAccountLockout(lockout)).toBe(true);
    });

    it('does not treat an ordinary wrong password as a lockout', () => {
        expect(isAccountLockout(wrongPassword)).toBe(false);
    });

    it('treats human verification as a lockout, since retrying cannot clear it', () => {
        expect(
            isAccountLockout(
                new AppError('PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED', { message: 'captcha' })
            )
        ).toBe(true);
    });

    it('ignores anything that is not one of our errors', () => {
        expect(isAccountLockout(new Error('boom'))).toBe(false);
        expect(isAccountLockout(undefined)).toBe(false);
    });
});

describe('formatDuration', () => {
    it('reads naturally at each scale', () => {
        expect(formatDuration(45)).toBe('45 Sekunden');
        expect(formatDuration(300)).toBe('5 Minuten');
        expect(formatDuration(6 * 3600)).toBe('6 Stunden');
        expect(formatDuration(3600 + 120)).toBe('1 Stunden 2 Minuten');
    });
});
