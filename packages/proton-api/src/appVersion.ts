/**
 * Proton requires third-party clients to identify themselves honestly.
 *
 * Their SDK documentation specifies the exact form:
 *
 *     external-<product>-<name>@<major.minor.patch>[-<channel>]
 *
 * and it is stricter than it looks. The **name segment may contain only lowercase letters and
 * underscores** — a dash there makes Proton's gateway mis-parse the header and reject the very
 * first call with HTTP 400, code 2064 "Invalid section name", which points nowhere near the actual
 * cause. That is why `proton_mail_sorter` is spelled with underscores while the project itself is
 * `proton-mail-sorter`.
 *
 * Clients that masquerade as a first-party Proton app are forbidden and may be blocked at any time.
 * We identify as ourselves: if Proton ever wants to throttle or block this tool specifically, they
 * should be able to.
 */

/** The Proton product whose API we talk to. */
export const PRODUCT = 'mail';

/** Underscores, not dashes — see above. */
export const APP_NAME = 'proton_mail_sorter';

export type ReleaseChannel = 'alpha' | 'beta' | 'stable';

const NAME_PATTERN = /^[a-z_]+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Built rather than hardcoded so the constraints are checked here, at startup, instead of
 * surfacing as an opaque 400 from Proton on the first request.
 */
export function buildAppVersion(version: string, channel: ReleaseChannel): string {
    if (!NAME_PATTERN.test(APP_NAME)) {
        throw new Error(
            `Invalid app name "${APP_NAME}": Proton allows only lowercase letters and underscores. ` +
                'A dash here is rejected as "Invalid section name" (code 2064).'
        );
    }
    if (!SEMVER_PATTERN.test(version)) {
        throw new Error(`Invalid app version "${version}": Proton expects major.minor.patch.`);
    }
    return `external-${PRODUCT}-${APP_NAME}@${version}-${channel}`;
}

/**
 * A plain, honest user agent. Deliberately not a browser string — pretending to be Chrome would be
 * exactly the masquerading Proton asks clients not to do.
 */
export function buildUserAgent(version: string): string {
    return `proton-mail-sorter/${version} (+https://github.com/kevin/proton-mail-sorter)`;
}
