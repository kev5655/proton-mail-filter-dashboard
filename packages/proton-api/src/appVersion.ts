/**
 * Proton requires third-party clients to identify themselves honestly.
 *
 * Their Drive SDK documentation states the rule plainly: use the
 * `external-<product>-<app>@<version>-<channel>` form, and clients that masquerade as a first-party
 * Proton app are forbidden and may be blocked at any time. We identify as ourselves. If Proton ever
 * wants to throttle or block this tool specifically, they should be able to.
 */
export const APP_NAME = 'external-mail-proton-mail-sorter';

export type ReleaseChannel = 'alpha' | 'beta' | 'stable';

export function buildAppVersion(version: string, channel: ReleaseChannel): string {
    return `${APP_NAME}@${version}-${channel}`;
}

/**
 * A plain, honest user agent. Deliberately not a browser string — pretending to be Chrome would be
 * exactly the masquerading Proton asks clients not to do.
 */
export function buildUserAgent(version: string): string {
    return `proton-mail-sorter/${version} (+https://github.com/kevin/proton-mail-sorter)`;
}
