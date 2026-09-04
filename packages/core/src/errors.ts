/**
 * Error taxonomy.
 *
 * Every failure this project can produce carries a stable machine code, a German message for the
 * user, a hint at what to do about it, and structured context. The code is shown in the UI and
 * written to the logs, so any report can be grepped straight back to the throw site.
 */

export const ERROR_CODES = [
    // Authentication against Proton
    'PROTON_AUTH_FAILED',
    'PROTON_AUTH_WRONG_PASSWORD',
    'PROTON_AUTH_HUMAN_VERIFICATION_REQUIRED',
    'PROTON_AUTH_2FA_REQUIRED',
    'PROTON_AUTH_2FA_INVALID',
    'PROTON_SESSION_EXPIRED',

    // Transport and API behaviour
    'PROTON_NETWORK_UNREACHABLE',
    'PROTON_RATE_LIMITED',
    'PROTON_API_ERROR',

    // The contract with Proton broke — the loud failure we deliberately want
    'PROTON_SCHEMA_MISMATCH',

    // Rule compilation and simulation
    'RULE_COMPILE_UNSUPPORTED_CONDITION',
    'RULE_COMPILE_FAILED',
    'RULE_SIEVE_REJECTED',

    // Verifying that Proton actually did what a rule promised
    'VERIFY_PARTIAL_MOVE',
    'VERIFY_RULE_NOT_FIRING',

    // Local storage and the tool's own login
    'VAULT_LOCKED',
    'VAULT_KEY_REJECTED',

    // Signing in through a real browser
    'BROWSER_NOT_INSTALLED',
    'BROWSER_LOGIN_UI_CHANGED',
    'BROWSER_LOGIN_TIMEOUT',
    'BROWSER_LOGIN_2FA_UNSUPPORTED',
    // A login started from the dashboard that could not even open: no profile, no browser.
    'BROWSER_LOGIN_NOT_CONFIGURED',

    // Getting credentials from wherever the user keeps them
    'CREDENTIALS_TOOL_MISSING',
    'CREDENTIALS_LOCKED',
    'CREDENTIALS_NOT_FOUND',
    'CREDENTIALS_EMPTY',
    'CREDENTIALS_MALFORMED',

    // The local server that hands the dashboard the mirrored mailbox
    'SERVER_PORT_IN_USE',
    'SERVER_DATABASE_MISSING',

    // Applying a confirmed change to the account. The whole point of these being distinct is that
    // "it did not happen" and "it half happened" are different situations for the person reading.
    'APPLY_NOT_CONFIRMED',
    'APPLY_CONFIRMATION_EXPIRED',
    'APPLY_STATE_STALE',
    'APPLY_BACKUP_FAILED',
    'APPLY_PARTIAL',
    'APPLY_ORDER_INCOMPLETE',
    'APPLY_BUSY',
    'APPLY_MALFORMED',
    'FOLDER_ALREADY_EXISTS',
    'WRITE_FILTER_FAILED',
    'WRITE_FOLDER_FAILED',

    // Reading back afterwards, because a write returning 200 means Proton accepted it, not that
    // any mail moved.
    'VERIFY_FILTER_NOT_STORED',

    // Undo
    'UNDO_ENTRY_ALREADY_UNDONE',
    'UNDO_PARTIAL_RESTORE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Free-form structured detail attached to an error. Must never contain secrets. */
export type ErrorContext = Record<string, unknown>;

export interface AppErrorOptions {
    /** What the user sees. German, plain, no stack-trace vocabulary. */
    message: string;
    /** What they can do about it. Omit when there is genuinely nothing to suggest. */
    hint?: string;
    /** Structured detail for the logs. */
    context?: ErrorContext;
    cause?: unknown;
}

export class AppError extends Error {
    readonly code: ErrorCode;
    readonly hint: string | undefined;
    readonly context: ErrorContext;

    constructor(code: ErrorCode, options: AppErrorOptions) {
        super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'AppError';
        this.code = code;
        this.hint = options.hint;
        this.context = options.context ?? {};
    }

    /** Shape sent to the UI and written to the log. */
    toJSON(): { code: ErrorCode; message: string; hint?: string; context: ErrorContext } {
        return {
            code: this.code,
            message: this.message,
            ...(this.hint === undefined ? {} : { hint: this.hint }),
            context: this.context,
        };
    }
}

export function isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
}

/**
 * Proton's response no longer matches what we expect.
 *
 * This is the error the whole fail-fast design exists for: rather than letting an `undefined` travel
 * three layers inward and surface as nonsense, we stop here and name the endpoint and the exact
 * field that changed.
 */
export class ProtonSchemaError extends AppError {
    constructor(params: {
        endpoint: string;
        issues: Array<{ path: string; expected: string; received: string }>;
        cause?: unknown;
    }) {
        const first = params.issues[0];
        const field = first ? ` (Feld \`${first.path}\`)` : '';
        super('PROTON_SCHEMA_MISMATCH', {
            message: `Proton hat das Antwortformat von \`${params.endpoint}\` geändert${field}.`,
            hint:
                'Das Tool ist bis zu einem Fix nicht sicher benutzbar. Bitte den Vorfall exportieren ' +
                '(Verlauf → Bericht exportieren) — daraus lässt sich der Adapter anpassen.',
            context: { endpoint: params.endpoint, issues: params.issues },
            ...(params.cause === undefined ? {} : { cause: params.cause }),
        });
        this.name = 'ProtonSchemaError';
    }
}

/**
 * Proton answered, but with an error of its own.
 *
 * Proton's own code and message are kept on the instance, not just in the text. Callers that wrap
 * this into something friendlier must pass them along: a wrapper that replaces "here is what Proton
 * said" with a guess turns a diagnosable failure into a mystery, which is exactly what happened
 * once already during the login work.
 */
export class ProtonApiError extends AppError {
    readonly httpStatus: number;
    readonly protonCode: number | undefined;
    readonly protonMessage: string | undefined;

    constructor(params: {
        endpoint: string;
        httpStatus: number;
        protonCode?: number;
        protonMessage?: string;
        /** Extra fields Proton attaches, e.g. the available human-verification methods. */
        details?: Record<string, unknown>;
        cause?: unknown;
    }) {
        const detail = params.protonMessage ? `: ${params.protonMessage}` : '';
        super('PROTON_API_ERROR', {
            message: `Proton hat \`${params.endpoint}\` mit HTTP ${params.httpStatus} abgelehnt${detail}`,
            context: {
                endpoint: params.endpoint,
                httpStatus: params.httpStatus,
                protonCode: params.protonCode,
                protonMessage: params.protonMessage,
                ...(params.details === undefined ? {} : { details: params.details }),
            },
            ...(params.cause === undefined ? {} : { cause: params.cause }),
        });
        this.name = 'ProtonApiError';
        this.httpStatus = params.httpStatus;
        this.protonCode = params.protonCode;
        this.protonMessage = params.protonMessage;
    }
}

/** Proton error codes we react to specifically. */
export const PROTON_ERROR_CODE = {
    /** "unusual activity targeting your account" — see login-guard.ts and auth.ts. */
    ACCOUNT_LOCKED: 2028,
    WRONG_PASSWORD: 8002,
    HUMAN_VERIFICATION_REQUIRED: 9001,
} as const;
