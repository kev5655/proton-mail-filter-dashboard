import type { Reply } from './handler.js';

/**
 * Who is allowed to ask this server to do something.
 *
 * Until now: anybody who could reach the port. There is no CSRF token on any route, no `Origin`
 * check, and the `Host` header was never looked at. On the loopback interface that was tolerable —
 * a process on this machine having the mailbox is the premise of the whole design — but it was
 * tolerable by accident rather than by decision, and it stops being tolerable the moment the server
 * is reachable over a tailnet: then any page open in any browser on any device of yours can `POST`
 * to it, and `/api/apply` plus `confirm-change` is the entire write path.
 *
 * The rule is deliberately blunt, because a subtle allowlist is one that silently locks somebody
 * out of their own dashboard:
 *
 *  - **Reads pass.** A `GET` cannot change anything, and the streams are `GET`s.
 *  - **A write needs an `Origin`.** Every browser sends one on a `POST`. Its absence means the
 *    request did not come from a page, and this server is only ever driven by one.
 *  - **That origin must be loopback, or the one this installation was told to expect.** Loopback in
 *    general rather than one exact port, because `pnpm dev` serves the page from vite on another
 *    port and proxies here with `changeOrigin: false` — and because „a page served from this
 *    machine" is already the premise. A page on the internet has neither.
 *  - **`Host` must match too.** Otherwise a name that resolves to this address is enough: the
 *    browser sends the attacker's own origin, which fails the check above, but re-checking the host
 *    costs one comparison and closes the rebinding shape rather than reasoning about it.
 */

/** What the server answers a request it will not take instructions from. */
const REFUSED = 'Diese Anfrage kam von einer Herkunft, der dieser Server nicht folgt.';

export interface OriginPolicy {
    /** The exact origin this installation is reached under, when it is not simply loopback. */
    publicOrigin?: string | undefined;
}

/** Hosts that mean „this machine", whatever port they carry. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostOf(value: string): string | undefined {
    try {
        return new URL(value).hostname;
    } catch {
        return undefined;
    }
}

function isLoopbackOrigin(origin: string): boolean {
    const url = ((): URL | undefined => {
        try {
            return new URL(origin);
        } catch {
            return undefined;
        }
    })();
    if (url === undefined) {
        return false;
    }
    // `http:` only. An `https://localhost` page is somebody's own proxy and is welcome to say so
    // through `publicOrigin`; guessing on its behalf would widen the rule for no known caller.
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether to refuse this request outright.
 *
 * Returns the reply to send, or `undefined` to carry on — so the caller reads as „refuse, or
 * route", and adding a route cannot accidentally skip the check.
 */
export function refuseForeignOrigin(
    method: string | undefined,
    headers: { origin?: string | undefined; host?: string | undefined },
    policy: OriginPolicy = {}
): Reply | undefined {
    if (method === undefined || method === 'GET' || method === 'HEAD') {
        return undefined;
    }

    const expectedHost = policy.publicOrigin === undefined ? undefined : hostOf(policy.publicOrigin);

    const origin = headers.origin;
    if (origin === undefined || origin === '') {
        return refusal('ohne Origin');
    }
    if (!isLoopbackOrigin(origin) && origin !== policy.publicOrigin) {
        return refusal('fremde Origin');
    }

    const host = headers.host;
    if (host !== undefined && host !== '') {
        // The header carries a port; the comparison is about the name.
        const name = host.replace(/:\d+$/, '');
        if (!LOOPBACK_HOSTS.has(name) && name !== expectedHost) {
            return refusal('fremder Host');
        }
    }

    return undefined;
}

function refusal(why: string): Reply {
    return {
        status: 403,
        body: {
            error: REFUSED,
            code: 'SERVER_ORIGIN_REFUSED',
            // Which of the three checks failed, so a misconfigured `PMS_PUBLIC_ORIGIN` is findable
            // from a log line instead of by reading this file.
            detail: why,
        },
    };
}
