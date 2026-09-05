/**
 * A link that opens one message in Proton's own web interface.
 *
 * This exists because the dashboard cannot show a mail body. Proton encrypts bodies end to end,
 * their metadata endpoint does not carry one, and until the Bridge path lands there is nothing to
 * render — so the honest affordance is to hand the reader over to the client that *can* decrypt it,
 * rather than to show them something invented.
 *
 * **The URL shape is a guess and is treated as one.** Nothing in this repository, in Proton's
 * vendored code, or in their published client tells us how their router builds a path to a single
 * message; it was read off a browser's address bar. So the host and the account index are settings
 * rather than constants, and when the parts a direct link needs are missing this falls back to a
 * search that is merely *useful* instead of a link that is confidently wrong.
 *
 * The account index is the `u/<n>` in the path — the browser's ordinal for signed-in accounts, not
 * anything Proton told us about this user. `0` is right for a single account and wrong the moment
 * there are two, which is exactly why it is editable.
 */

export interface ProtonLinkConfig {
    /** Without a scheme: `mail.proton.me`. */
    host: string;
    /** The `u/<n>` ordinal. Zero for the only account signed in. */
    account: number;
}

export const DEFAULT_LINK_CONFIG: ProtonLinkConfig = { host: 'mail.proton.me', account: 0 };

export interface LinkableMessage {
    ID: string;
    Subject: string;
    /** Proton shows conversations, so this is the better target when we have it. */
    ConversationID?: string | undefined;
}

/**
 * Where to send the reader for this message.
 *
 * Prefers the conversation, because that is what Proton's mailbox actually displays. Falls back to
 * a search for the subject: less precise, but it lands somewhere real and readable, which a
 * malformed direct link would not.
 */
export function protonMailUrl(message: LinkableMessage, config: ProtonLinkConfig = DEFAULT_LINK_CONFIG): string {
    const base = `https://${config.host}/u/${String(Math.max(0, Math.trunc(config.account)))}`;
    const target = message.ConversationID ?? message.ID;

    if (target === '') {
        return searchUrl(base, message.Subject);
    }
    return `${base}/almost-all-mail/${encodeURIComponent(target)}`;
}

/** The fallback, also useful on its own when a message id is meaningless — as in the demo. */
export function protonSearchUrl(subject: string, config: ProtonLinkConfig = DEFAULT_LINK_CONFIG): string {
    return searchUrl(`https://${config.host}/u/${String(Math.max(0, Math.trunc(config.account)))}`, subject);
}

function searchUrl(base: string, subject: string): string {
    return `${base}/all-mail#keyword=${encodeURIComponent(subject)}`;
}
