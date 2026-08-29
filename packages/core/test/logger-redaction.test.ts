import { Writable } from 'node:stream';

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors.js';
import { __testing } from '../src/logger.js';

/**
 * The redaction guarantee, tested.
 *
 * `packages/core/src/logger.ts` claims that a secret can never reach a log line even if someone
 * carelessly logs a whole session object. A claim like that is worth exactly as much as its test,
 * so this suite reproduces the logger's configuration and throws the real secret-shaped payloads
 * at it.
 */

function captureLog(payload: unknown): string {
    const lines: string[] = [];
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });

    const logger = pino(
        {
            level: 'trace',
            redact: { paths: __testing.REDACT_PATHS, censor: '[redacted]' },
        },
        sink
    );
    logger.info(payload as object, 'test');
    return lines.join('');
}

const SECRET = 'hunter2-do-not-log-this';

describe('log redaction', () => {
    it.each(__testing.SECRET_KEYS)('redacts %s at the top level', (key) => {
        const output = captureLog({ [key]: SECRET });
        expect(output).not.toContain(SECRET);
        expect(output).toContain('[redacted]');
    });

    it('redacts a whole session object logged by accident', () => {
        const output = captureLog({
            session: { uid: SECRET, accessToken: SECRET, refreshToken: 'also-secret' },
        });
        expect(output).not.toContain(SECRET);
    });

    it('redacts secrets nested three levels deep', () => {
        const output = captureLog({ a: { b: { c: { password: SECRET } } } });
        expect(output).not.toContain(SECRET);
    });

    it('keeps non-secret context, so logs stay useful', () => {
        const output = captureLog({ endpoint: 'GET mail/v4/filters', filterCount: 12 });
        expect(output).toContain('mail/v4/filters');
        expect(output).toContain('12');
    });

    it('never carries a password through an error context', () => {
        const error = new AppError('PROTON_AUTH_FAILED', {
            message: 'nope',
            context: { password: SECRET },
        });
        const output = captureLog({ err: error.toJSON() });
        expect(output).not.toContain(SECRET);
    });
});
