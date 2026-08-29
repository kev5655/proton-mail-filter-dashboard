import { AppError, ProtonApiError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { z } from 'zod';

import { buildUserAgent, resolveAppVersion } from './appVersion.js';
import { parseResponse } from './validate.js';

const log = getLogger('proton-api');

export const PROTON_API_BASE = 'https://mail.proton.me/api';

export interface ProtonSession {
    uid: string;
    accessToken: string;
    refreshToken: string;
    /**
     * The session cookies, as a `Cookie` header value, when the session came from a browser.
     *
     * Proton's web login answers in cookie mode: `core/v4/auth` returns the UID and the scope but
     * no tokens, because the server sets them as cookies instead. A session captured from a browser
     * therefore carries both — the access token read out of the `AUTH-<UID>` cookie, and the cookies
     * themselves, which are what the browser would have sent. Sending both is what a browser
     * effectively does and costs nothing.
     */
    cookies?: string | undefined;
}

export interface ProtonHttpOptions {
    version: string;
    /** Overrides the `x-pm-appversion` header. Only for probing what Proton accepts. */
    appVersion?: string;
    baseUrl?: string;
    /** Overall attempts per request, including the first. Only 429 and 5xx are retried. */
    maxAttempts?: number;
    /**
     * Smallest gap between two requests, in milliseconds.
     *
     * Not a rate *limit* — Proton enforces those itself — but a self-imposed pace. The tool reads a
     * mailbox to answer questions nobody is waiting on by the second, so there is no reason for it
     * to cost Proton more than a person clicking through their own interface would. Set to 0 in
     * tests, never in anything that talks to the real API.
     */
    minIntervalMs?: number;
    /**
     * Random extra delay on top, in milliseconds.
     *
     * A request exactly every 900 ms is a metronome, and a metronome is a machine signature. The
     * jitter costs nothing and keeps the traffic from having a shape.
     */
    jitterMs?: number;
    /** Injected in tests. */
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Injected in tests, so pacing can be asserted without waiting for a clock. */
    now?: () => number;
    random?: () => number;
}

/** Roughly the pace of someone working through their own mailbox. */
export const DEFAULT_MIN_INTERVAL_MS = 900;
export const DEFAULT_JITTER_MS = 600;

interface RequestOptions {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    /** Send without the session headers. Only the very first call of the login does this. */
    anonymous?: boolean;
    /** Extra headers for this one request. Merged last, so it can override the defaults. */
    headers?: Record<string, string>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Proton attaches a `Details` object to some errors — most usefully the available human-verification
 * methods. It can also carry tokens, so only the shape and short scalar values are kept: enough to
 * diagnose, not enough to leak.
 */
function summariseDetails(details: unknown): Record<string, unknown> | undefined {
    if (details === null || typeof details !== 'object') {
        return undefined;
    }
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (typeof value === 'number' || typeof value === 'boolean') {
            summary[key] = value;
        } else if (typeof value === 'string') {
            summary[key] = value.length <= 40 ? value : `string(length ${value.length})`;
        } else if (Array.isArray(value)) {
            summary[key] = value.every((item) => typeof item === 'string' && item.length <= 40)
                ? value
                : `array(${value.length})`;
        } else if (value !== null && typeof value === 'object') {
            summary[key] = `object{${Object.keys(value).slice(0, 8).join(',')}}`;
        }
    }
    return summary;
}

export class ProtonHttp {
    readonly #baseUrl: string;
    readonly #appVersion: string;
    readonly #userAgent: string;
    readonly #maxAttempts: number;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<void>;
    readonly #now: () => number;
    readonly #random: () => number;
    readonly #minIntervalMs: number;
    readonly #jitterMs: number;
    #session: ProtonSession | undefined;
    /** Requests queue behind one another so a burst becomes a sequence. */
    #pacing: Promise<unknown> = Promise.resolve();
    #lastRequestAt = 0;

    constructor(options: ProtonHttpOptions) {
        this.#baseUrl = options.baseUrl ?? PROTON_API_BASE;
        this.#appVersion = resolveAppVersion(options.appVersion);
        this.#userAgent = buildUserAgent(options.version);
        this.#maxAttempts = options.maxAttempts ?? 3;
        this.#fetch = options.fetchImpl ?? globalThis.fetch;
        this.#sleep = options.sleep ?? defaultSleep;
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? Math.random;
        this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
        this.#jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    }

    /**
     * Wait until it is this request's turn, and until enough time has passed since the last one.
     *
     * Chained rather than counted, so ten calls started at once leave one at a time instead of all
     * ten waiting the same interval and then going together — which would produce exactly the burst
     * this is meant to avoid.
     */
    async #pace(): Promise<void> {
        const turn = this.#pacing.then(async () => {
            const gap = this.#minIntervalMs + Math.floor(this.#random() * this.#jitterMs);
            const waitMs = gap - (this.#now() - this.#lastRequestAt);
            if (waitMs > 0) {
                await this.#sleep(waitMs);
            }
            this.#lastRequestAt = this.#now();
        });
        this.#pacing = turn.catch(() => undefined);
        await turn;
    }

    setSession(session: ProtonSession | undefined): void {
        this.#session = session;
    }

    get session(): ProtonSession | undefined {
        return this.#session;
    }

    /** Perform a request and validate the response against `schema`. */
    async request<S extends z.ZodType>(options: RequestOptions, schema: S): Promise<z.output<S>> {
        const raw = await this.#send(options);
        return parseResponse(schema, raw, `${options.method} ${options.path}`);
    }

    /** Perform a request and return the parsed JSON unvalidated. Only for recording fixtures. */
    async requestRaw(options: RequestOptions): Promise<unknown> {
        return this.#send(options);
    }

    async #send(options: RequestOptions): Promise<unknown> {
        const url = new URL(`${this.#baseUrl}/${options.path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }

        const endpoint = `${options.method} ${options.path}`;
        let lastError: unknown;

        for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
            await this.#pace();

            let response: Response;
            try {
                response = await this.#fetch(url, {
                    method: options.method,
                    headers: { ...this.#headers(options.anonymous === true), ...options.headers },
                    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
                });
            } catch (cause) {
                lastError = new AppError('PROTON_NETWORK_UNREACHABLE', {
                    message: `Proton ist nicht erreichbar (\`${endpoint}\`).`,
                    hint: 'Internetverbindung prüfen. Das Tool hat nichts verändert.',
                    context: { endpoint, attempt },
                    cause,
                });
                if (attempt < this.#maxAttempts) {
                    await this.#backoff(attempt, endpoint, 'network');
                    continue;
                }
                throw lastError;
            }

            if (response.status === 429 || response.status >= 500) {
                lastError = await this.#toApiError(response, endpoint);
                if (attempt < this.#maxAttempts) {
                    await this.#backoff(attempt, endpoint, String(response.status), response);
                    continue;
                }
                if (response.status === 429) {
                    throw new AppError('PROTON_RATE_LIMITED', {
                        message: 'Proton drosselt die Anfragen.',
                        hint: 'Kurz warten und erneut versuchen. Der Sync setzt dort fort, wo er stand.',
                        context: { endpoint },
                        cause: lastError,
                    });
                }
                throw lastError;
            }

            if (!response.ok) {
                throw await this.#toApiError(response, endpoint);
            }

            log.debug({ endpoint, status: response.status, attempt }, 'proton request ok');
            return (await response.json()) as unknown;
        }

        /* istanbul ignore next -- the loop either returns or throws */
        throw lastError;
    }

    #headers(anonymous: boolean): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/vnd.protonmail.v1+json',
            // Proton asks third-party clients to identify themselves honestly. See appVersion.ts.
            'x-pm-appversion': this.#appVersion,
            'User-Agent': this.#userAgent,
        };
        if (!anonymous && this.#session !== undefined) {
            headers['x-pm-uid'] = this.#session.uid;
            if (this.#session.accessToken !== '') {
                headers['Authorization'] = `Bearer ${this.#session.accessToken}`;
            }
            if (this.#session.cookies !== undefined && this.#session.cookies !== '') {
                headers['Cookie'] = this.#session.cookies;
            }
        }
        return headers;
    }

    async #backoff(attempt: number, endpoint: string, reason: string, response?: Response): Promise<void> {
        const retryAfter = Number(response?.headers.get('retry-after') ?? NaN);
        const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 500;
        log.warn({ endpoint, attempt, reason, delayMs }, 'retrying proton request');
        await this.#sleep(delayMs);
    }

    async #toApiError(response: Response, endpoint: string): Promise<ProtonApiError> {
        let protonCode: number | undefined;
        let protonMessage: string | undefined;
        let details: Record<string, unknown> | undefined;
        try {
            const body = (await response.json()) as { Code?: unknown; Error?: unknown; Details?: unknown };
            protonCode = typeof body.Code === 'number' ? body.Code : undefined;
            protonMessage = typeof body.Error === 'string' ? body.Error : undefined;
            details = summariseDetails(body.Details);
        } catch {
            // A non-JSON error body is itself useful information; the status carries the rest.
        }
        return new ProtonApiError({
            endpoint,
            httpStatus: response.status,
            ...(protonCode === undefined ? {} : { protonCode }),
            ...(protonMessage === undefined ? {} : { protonMessage }),
            ...(details === undefined ? {} : { details }),
        });
    }
}
