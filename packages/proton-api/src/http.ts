import { AppError, ProtonApiError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { z } from 'zod';

import { buildAppVersion, buildUserAgent, type ReleaseChannel } from './appVersion.js';
import { parseResponse } from './validate.js';

const log = getLogger('proton-api');

export const PROTON_API_BASE = 'https://mail.proton.me/api';

export interface ProtonSession {
    uid: string;
    accessToken: string;
    refreshToken: string;
}

export interface ProtonHttpOptions {
    version: string;
    channel: ReleaseChannel;
    baseUrl?: string;
    /** Overall attempts per request, including the first. Only 429 and 5xx are retried. */
    maxAttempts?: number;
    /** Injected in tests. */
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    /** Send without the session headers. Only the pre-login auth calls do this. */
    anonymous?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ProtonHttp {
    readonly #baseUrl: string;
    readonly #appVersion: string;
    readonly #userAgent: string;
    readonly #maxAttempts: number;
    readonly #fetch: typeof fetch;
    readonly #sleep: (ms: number) => Promise<void>;
    #session: ProtonSession | undefined;

    constructor(options: ProtonHttpOptions) {
        this.#baseUrl = options.baseUrl ?? PROTON_API_BASE;
        this.#appVersion = buildAppVersion(options.version, options.channel);
        this.#userAgent = buildUserAgent(options.version);
        this.#maxAttempts = options.maxAttempts ?? 3;
        this.#fetch = options.fetchImpl ?? globalThis.fetch;
        this.#sleep = options.sleep ?? defaultSleep;
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
            let response: Response;
            try {
                response = await this.#fetch(url, {
                    method: options.method,
                    headers: this.#headers(options.anonymous === true),
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
            headers['Authorization'] = `Bearer ${this.#session.accessToken}`;
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
        try {
            const body = (await response.json()) as { Code?: unknown; Error?: unknown };
            protonCode = typeof body.Code === 'number' ? body.Code : undefined;
            protonMessage = typeof body.Error === 'string' ? body.Error : undefined;
        } catch {
            // A non-JSON error body is itself useful information; the status carries the rest.
        }
        return new ProtonApiError({
            endpoint,
            httpStatus: response.status,
            ...(protonCode === undefined ? {} : { protonCode }),
            ...(protonMessage === undefined ? {} : { protonMessage }),
        });
    }
}
