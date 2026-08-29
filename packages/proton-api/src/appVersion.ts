/**
 * The `x-pm-appversion` header, which Proton requires on every request.
 *
 * Getting this right took two rejections from the live API, both worth recording because neither
 * error message points at the header:
 *
 *  1. `external-mail-proton-mail-sorter@0.1.0-alpha` → HTTP 400, code 2064 "Invalid section name".
 *     Proton parses the header positionally and their SDK allows only lowercase letters and
 *     underscores in the name segment; the dashes shifted the parse.
 *  2. `external-mail-proton_mail_sorter@0.1.0-alpha` → HTTP 400, code 5002 "Invalid app version".
 *     The `external-<product>-<name>` form is documented for **Proton Drive** and is not accepted
 *     by the Mail API, which validates against its own set of known clients.
 *
 * That leaves `Other`, the value third-party Proton clients have used for years — hydroxide sends
 * it by default. It is the honest answer to "which client are you": not a Proton one.
 *
 * What we will **not** do is send something like `web-mail@5.x.x`. Proton states plainly that
 * clients masquerading as first-party apps are forbidden and may be blocked at any time, and a tool
 * that manages someone's mail filters is the last place to start by lying about what it is. If
 * `Other` ever stops working, the answer is to ask Proton, not to impersonate their client.
 */

export const DEFAULT_APP_VERSION = 'Other';

export type ReleaseChannel = 'alpha' | 'beta' | 'stable';

/**
 * Values known to be rejected, so an experiment cannot silently reintroduce one.
 * Matching is done on the leading form, since the version and channel vary.
 */
const REJECTED_PREFIXES = ['external-'] as const;

/** Prefixes reserved for Proton's own clients. Sending one of these would be impersonation. */
const FIRST_PARTY_PREFIXES = ['web-', 'linux-', 'macos-', 'windows-', 'ios-', 'android-'] as const;

export function resolveAppVersion(override?: string | undefined): string {
    const value = override?.trim();
    if (value === undefined || value === '') {
        return DEFAULT_APP_VERSION;
    }

    const lower = value.toLowerCase();
    for (const prefix of FIRST_PARTY_PREFIXES) {
        if (lower.startsWith(prefix)) {
            throw new Error(
                `Refusing to send x-pm-appversion "${value}": that identifies this tool as an official ` +
                    'Proton client, which Proton forbids. Use "Other", or a value that is honestly ours.'
            );
        }
    }
    for (const prefix of REJECTED_PREFIXES) {
        if (lower.startsWith(prefix)) {
            throw new Error(
                `x-pm-appversion "${value}" uses the external-* form, which Proton Mail rejects with ` +
                    'code 5002 (it is documented for Proton Drive only). Use "Other".'
            );
        }
    }
    return value;
}

/**
 * A plain, honest user agent. Deliberately not a browser string — pretending to be Chrome would be
 * exactly the masquerading Proton asks clients not to do.
 */
export function buildUserAgent(version: string): string {
    return `proton-mail-sorter/${version} (+https://github.com/kevin/proton-mail-sorter)`;
}
