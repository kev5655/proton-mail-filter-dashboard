import { AppError, ProtonApiError } from '@pms/core/errors';
import { describe, expect, it } from 'vitest';

import { describeLoginFailure } from '../src/auth.js';

/**
 * What the user is told when a login fails.
 *
 * The first version of this answered every failed login with "check username and password". It was
 * wrong twice in a row — once when the real cause was an empty password from a broken prompt, once
 * when Proton was rejecting the client itself — and both times it pointed at the one thing that was
 * fine, which cost several rounds of guessing.
 *
 * So these tests are about honesty, not wording: Proton's own code and message must survive into
 * the error, and only code 8002 may claim the password was wrong.
 */

function protonRejects(
    code: number,
    message: string,
    httpStatus = 422,
    details?: Record<string, unknown>
): ProtonApiError {
    return new ProtonApiError({
        endpoint: 'POST core/v4/auth',
        httpStatus,
        protonCode: code,
        protonMessage: message,
        ...(details === undefined ? {} : { details }),
    });
}

describe('login failure reporting', () => {
    it('claims a wrong password only when Proton says code 8002', () => {
        const error = describeLoginFailure(protonRejects(8002, 'Incorrect login credentials', 401), 4);

        expect(error.code).toBe('PROTON_AUTH_WRONG_PASSWORD');
        expect(error.context['protonCode']).toBe(8002);
        // Two-password accounts are a real trap here, so the hint names which password is meant.
        expect(error.hint).toMatch(/Login-Passwort/);
    });

    it('never blames the password for an error Proton did not attribute to it', () => {
        for (const error of [
            describeLoginFailure(protonRejects(5002, 'Invalid app version', 400), 4),
            describeLoginFailure(protonRejects(2064, 'Invalid section name', 400), 4),
            describeLoginFailure(protonRejects(2028, 'Unauthorized', 401), 4),
        ]) {
            expect(error.code).not.toBe('PROTON_AUTH_WRONG_PASSWORD');
            expect(error.message).not.toMatch(/Passwort/);
        }
    });

    it("keeps Proton's own code and wording instead of replacing them with a guess", () => {
        const error = describeLoginFailure(protonRejects(5002, 'Invalid app version', 400), 4);
        const serialised = JSON.stringify(error.toJSON());

        expect(error.message).toContain('Invalid app version');
        expect(serialised).toContain('5002');
        expect(error.hint).toMatch(/Protons Wortlaut/);
    });

    it('recognises human verification, which no amount of password checking would fix', () => {
        const error = describeLoginFailure(
            protonRejects(9001, 'Human verification required', 422, {
                HumanVerificationMethods: ['captcha', 'email'],
            }),
            4
        );

        expect(error.code).toBe('PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED');
        expect(JSON.stringify(error.context)).toContain('captcha');
        expect(error.hint).toMatch(/mail\.proton\.me/);
    });

    it('records the auth version, since it changes how the password is hashed', () => {
        const error = describeLoginFailure(protonRejects(8002, 'Incorrect login credentials', 401), 2);
        expect(error.context['authVersion']).toBe(2);
    });

    it('passes an AppError through rather than burying it', () => {
        const original = new AppError('PROTON_RATE_LIMITED', { message: 'zu viele Anfragen' });
        expect(describeLoginFailure(original, 4)).toBe(original);
    });

    it('still reports something useful for a failure that is not from the API at all', () => {
        const error = describeLoginFailure(new TypeError('fetch exploded'), 4);

        expect(error.code).toBe('PROTON_AUTH_FAILED');
        expect(error.context['authVersion']).toBe(4);
    });
});
