import pino, { type Logger, type LoggerOptions } from 'pino';

import { isAppError } from './errors.js';

/**
 * Keys whose values must never reach a log line, at any depth.
 *
 * pino's `redact` is a hard guarantee at serialisation time, which is what we want: a future
 * careless `log.info({ session })` gets scrubbed instead of leaking. `censor` is a fixed string so
 * a redacted field is visibly redacted rather than merely absent.
 */
const SECRET_KEYS = [
    'password',
    'Password',
    'loginPassword',
    'mailboxPassword',
    'keyPassword',
    'twoFactorCode',
    'totp',
    'TwoFactorCode',
    'accessToken',
    'AccessToken',
    'refreshToken',
    'RefreshToken',
    'uid',
    'UID',
    'cookie',
    'Cookie',
    'authorization',
    'Authorization',
    'clientProof',
    'ClientProof',
    'clientEphemeral',
    'ClientEphemeral',
    'srpSession',
    'SRPSession',
    'verifier',
    'Verifier',
    'privateKey',
    'PrivateKey',
    'vaultKey',
    'dbKey',
];

const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]);

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LoggerConfig {
    level?: LogLevel;
    /** Per-module overrides, e.g. `{ 'proton-api': 'debug' }`. */
    moduleLevels?: Partial<Record<string, LogLevel>>;
    /** Write JSON lines here in addition to stdout. */
    file?: string;
}

let rootConfig: LoggerConfig = {};
let root: Logger | undefined;

/**
 * Diagnostics go to stderr, never to stdout.
 *
 * The commands here talk to a person: `pnpm spike` and `pnpm sync` print counts and prompts that
 * are read as they appear. A JSON log line landing in the middle of that splits a sentence in two
 * and makes a successful run look like a fault — which is exactly what happened when a session
 * refresh logged itself between "Sitzungs-Passphrase übernommen" and the result. Keeping the two
 * streams apart also means `pnpm spike > out.txt` captures the report without the log, and
 * `2> log.jsonl` captures the log without the report.
 */
function build(config: LoggerConfig): Logger {
    const options: LoggerOptions = {
        level: config.level ?? 'info',
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        serializers: {
            err: (error: unknown) => {
                if (isAppError(error)) {
                    return { ...error.toJSON(), stack: error.stack };
                }
                return pino.stdSerializers.err(error as Error);
            },
        },
        formatters: {
            level: (label) => ({ level: label }),
        },
    };

    if (config.file !== undefined) {
        return pino(
            options,
            pino.multistream([
                { stream: process.stderr },
                { stream: pino.destination({ dest: config.file, mkdir: true, sync: false }) },
            ])
        );
    }
    return pino(options, process.stderr);
}

export function configureLogging(config: LoggerConfig): void {
    rootConfig = config;
    root = build(config);
}

/**
 * A logger for one module. Modules can be turned up individually without drowning the rest —
 * `LOG_LEVEL_PROTON_API=debug` while everything else stays on `info`.
 */
export function getLogger(module: string): Logger {
    root ??= build(rootConfig);
    const override = rootConfig.moduleLevels?.[module];
    const child = root.child({ module });
    if (override !== undefined) {
        child.level = override;
    }
    return child;
}

/** Correlation id for one request or one sync run, so its lines can be pulled out of the noise. */
export function withCorrelation(logger: Logger, correlationId: string): Logger {
    return logger.child({ correlationId });
}

/** Exposed for the redaction test — the guarantee is only worth what it is tested against. */
export const __testing = { SECRET_KEYS, REDACT_PATHS };
