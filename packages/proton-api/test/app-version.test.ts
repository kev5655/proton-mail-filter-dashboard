import { describe, expect, it } from 'vitest';

import { buildUserAgent, DEFAULT_APP_VERSION, resolveAppVersion } from '../src/appVersion.js';

/**
 * Regression cover for the first two things that went wrong against the real API, plus a guard
 * against the tempting way out of them.
 *
 * `external-mail-proton-mail-sorter@…` was rejected with code 2064 ("Invalid section name"),
 * `external-mail-proton_mail_sorter@…` with code 5002 ("Invalid app version"). Neither message
 * points at the header, so both are pinned here by their values rather than left to memory.
 *
 * The last test is the important one. The obvious fix for 5002 is to send `web-mail@5.x.x` and
 * sail straight through. Proton forbids exactly that, so the code refuses it rather than leaving
 * it one edit away.
 */

describe('x-pm-appversion', () => {
    it('defaults to the value third-party clients use', () => {
        expect(resolveAppVersion()).toBe('Other');
        expect(DEFAULT_APP_VERSION).toBe('Other');
    });

    it('falls back to the default for an empty override', () => {
        expect(resolveAppVersion('')).toBe(DEFAULT_APP_VERSION);
        expect(resolveAppVersion('   ')).toBe(DEFAULT_APP_VERSION);
    });

    it('rejects the external-* form that Proton Mail answered with code 5002', () => {
        expect(() => resolveAppVersion('external-mail-proton_mail_sorter@0.1.0-alpha')).toThrow(/5002/);
        expect(() => resolveAppVersion('external-drive-myapp@1.2.3-stable')).toThrow(/5002/);
    });

    it.each([
        'web-mail@5.0.99.0',
        'linux-mail@3.2.0',
        'android-mail@4.0.0',
        'ios-mail@6.1.0',
        'WEB-MAIL@5.0.0',
    ])('refuses to impersonate a Proton client: %s', (value) => {
        expect(() => resolveAppVersion(value)).toThrow(/forbids/);
    });

    it('allows an honest override, so a value Proton accepts can be tried without a code change', () => {
        expect(resolveAppVersion('Other')).toBe('Other');
        expect(resolveAppVersion('proton_mail_sorter@0.1.0')).toBe('proton_mail_sorter@0.1.0');
    });

    it('does not pretend to be a browser in the user agent either', () => {
        expect(buildUserAgent('0.1.0')).not.toMatch(/Mozilla|Chrome|Safari/);
        expect(buildUserAgent('0.1.0')).toContain('proton-mail-sorter/0.1.0');
    });
});
