import { describe, expect, it } from 'vitest';

import { APP_NAME, buildAppVersion, buildUserAgent, PRODUCT } from '../src/appVersion.js';

/**
 * Regression cover for the first thing that went wrong against the real API.
 *
 * The initial header was `external-mail-proton-mail-sorter@0.1.0-alpha`. Proton rejected the very
 * first request — `POST core/v4/auth/info`, HTTP 400, code 2064 "Invalid section name" — because
 * their gateway parses the header positionally and the dashes in the name segment shifted it.
 * Their SDK documentation allows lowercase letters and underscores there, nothing else.
 *
 * These tests exist so that constraint cannot be quietly undone by a rename.
 */

describe('x-pm-appversion', () => {
    it('matches the form Proton documents for third-party clients', () => {
        expect(buildAppVersion('0.1.0', 'alpha')).toBe('external-mail-proton_mail_sorter@0.1.0-alpha');
        expect(buildAppVersion('1.2.3', 'stable')).toMatch(
            /^external-[a-z]+-[a-z_]+@\d+\.\d+\.\d+-(alpha|beta|stable)$/
        );
    });

    it('uses underscores in the app name, never dashes', () => {
        expect(APP_NAME).toMatch(/^[a-z_]+$/);
        expect(APP_NAME).not.toContain('-');
        expect(PRODUCT).toMatch(/^[a-z]+$/);
    });

    it('rejects a version Proton would not parse', () => {
        expect(() => buildAppVersion('0.1', 'alpha')).toThrow(/major\.minor\.patch/);
        expect(() => buildAppVersion('v0.1.0', 'alpha')).toThrow(/major\.minor\.patch/);
    });

    it('identifies as itself rather than imitating a Proton client', () => {
        const header = buildAppVersion('0.1.0', 'alpha');
        expect(header.startsWith('external-')).toBe(true);
        expect(buildUserAgent('0.1.0')).not.toMatch(/Mozilla|Chrome|Safari/);
    });
});
