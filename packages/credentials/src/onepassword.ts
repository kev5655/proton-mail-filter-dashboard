import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

import { requirePassword, requireTotp, requireUsername, type CredentialOrigin } from './verify.js';

const log = getLogger('credentials-1password');

/**
 * Credentials from 1Password, via its CLI.
 *
 * Nothing here handles the secret beyond passing it on: `op` talks to the 1Password app, the app
 * asks for the fingerprint, and the value goes straight into the SRP handshake. It is never logged,
 * never written to disk, and never included in an error — the log lines record lengths and
 * outcomes, which is enough to debug and useless to an attacker.
 *
 * Every value is verified before use. See `verify.ts` for why that is not paranoia.
 */

const execFileAsync = promisify(execFile);

export interface OnePasswordConfig {
    /** Vault name, e.g. "Kevin Private". */
    vault: string;
    /** Item title, e.g. "Proton". */
    item: string;
    /** Field labels to try, in order. Different item templates name them differently. */
    usernameFields?: string[];
    passwordFields?: string[];
    /** Injected in tests. */
    run?: (args: string[]) => Promise<string>;
}

const DEFAULT_USERNAME_FIELDS = ['username', 'email'];
const DEFAULT_PASSWORD_FIELDS = ['password'];

export interface CredentialSource {
    readonly name: string;
    getUsername(): Promise<string>;
    getPassword(): Promise<string>;
    /** Undefined when this source has no TOTP for the item; the caller then prompts. */
    getTotp(): Promise<string | undefined>;
}

export function createOnePasswordSource(config: OnePasswordConfig): CredentialSource {
    const run = config.run ?? runOp;
    const name = `1Password (${config.vault}/${config.item})`;
    const origin = (label: string): CredentialOrigin => ({ source: name, label });

    const readField = async (fields: string[], label: string): Promise<string | undefined> => {
        for (const field of fields) {
            const reference = `op://${config.vault}/${config.item}/${field}`;
            try {
                const value = await run(['read', reference]);
                log.debug({ field, length: value.trim().length }, 'read field from 1password');
                return value;
            } catch (error) {
                if (isFieldMissing(error)) {
                    // Templates differ; try the next label before giving up.
                    continue;
                }
                throw translate(error, config, label);
            }
        }
        return undefined;
    };

    return {
        name,

        async getUsername(): Promise<string> {
            const fields = config.usernameFields ?? DEFAULT_USERNAME_FIELDS;
            const value = await readField(fields, 'Benutzername');
            if (value === undefined) {
                throw missingField(config, fields, 'Benutzername');
            }
            return requireUsername(value, origin('Benutzername'));
        },

        async getPassword(): Promise<string> {
            const fields = config.passwordFields ?? DEFAULT_PASSWORD_FIELDS;
            const value = await readField(fields, 'Passwort');
            if (value === undefined) {
                throw missingField(config, fields, 'Passwort');
            }
            return requirePassword(value, origin('Passwort'));
        },

        async getTotp(): Promise<string | undefined> {
            let value: string;
            try {
                value = await run(['item', 'get', config.item, '--vault', config.vault, '--otp']);
            } catch (error) {
                if (isFieldMissing(error)) {
                    // No one-time password stored on the item. The caller falls back to a prompt.
                    log.debug('item has no otp field');
                    return undefined;
                }
                throw translate(error, config, '2FA-Code');
            }
            if (value.trim() === '') {
                return undefined;
            }
            return requireTotp(value, origin('2FA-Code'));
        },
    };
}

/**
 * Field labels on the item, for diagnosing a wrong configuration.
 *
 * Labels only — never values. When the item is not laid out the way this code expects, the useful
 * question is "what is it called", and answering it must not require anyone to reveal a password.
 */
export async function describeItem(config: OnePasswordConfig): Promise<string[]> {
    const run = config.run ?? runOp;
    let json: string;
    try {
        json = await run(['item', 'get', config.item, '--vault', config.vault, '--format', 'json']);
    } catch (error) {
        throw translate(error, config, 'Eintrag');
    }

    const parsed = JSON.parse(json) as { fields?: Array<{ label?: string; id?: string; type?: string }> };
    return (parsed.fields ?? []).map((field) => `${field.label ?? field.id ?? '?'} (${field.type ?? '?'})`);
}

async function runOp(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('op', args, {
        encoding: 'utf8',
        // The fingerprint prompt needs time; the default would cut it off mid-approval.
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
    });
    return stdout;
}

interface ExecError {
    code?: string | number;
    stderr?: string;
}

function stderrOf(error: unknown): string {
    return String((error as ExecError).stderr ?? '');
}

type Failure = 'tool-missing' | 'locked' | 'item-missing' | 'field-missing' | 'unknown';

/**
 * Classify an `op` failure from its stderr.
 *
 * Order matters more than the patterns do. A locked vault fails every field lookup, so if that were
 * mistaken for "this field does not exist" the caller would quietly try the next field name and
 * report a missing field — sending someone to check their item layout when the real answer is
 * "unlock 1Password". Sign-in and item problems are therefore ruled out first.
 */
function classify(error: unknown): Failure {
    if ((error as ExecError).code === 'ENOENT') {
        return 'tool-missing';
    }

    const stderr = stderrOf(error).toLowerCase();

    if (
        stderr.includes('signed in') ||
        stderr.includes('sign in') ||
        stderr.includes('authoriz') ||
        stderr.includes('session') ||
        stderr.includes('unlock')
    ) {
        return 'locked';
    }

    if (stderr.includes("isn't an item") || stderr.includes("isn't a vault") || stderr.includes('no item')) {
        return 'item-missing';
    }

    if (stderr.includes('field') || stderr.includes('no such') || stderr.includes('not found')) {
        return 'field-missing';
    }

    return 'unknown';
}

function isFieldMissing(error: unknown): boolean {
    return classify(error) === 'field-missing';
}

function missingField(config: OnePasswordConfig, fields: string[], label: string): AppError {
    return new AppError('CREDENTIALS_NOT_FOUND', {
        message: `Im 1Password-Eintrag "${config.item}" gibt es kein Feld für ${label}.`,
        hint:
            `Gesucht wurde nach: ${fields.join(', ')}. Welche Felder der Eintrag wirklich hat, zeigt ` +
            '`pnpm spike --describe-1password` — das gibt nur die Feldnamen aus, keine Werte.',
        context: { vault: config.vault, item: config.item, triedFields: fields },
    });
}

function translate(error: unknown, config: OnePasswordConfig, label: string): AppError {
    const stderr = stderrOf(error);
    const context = { vault: config.vault, item: config.item, label };

    switch (classify(error)) {
        case 'tool-missing':
            return new AppError('CREDENTIALS_TOOL_MISSING', {
                message: 'Die 1Password-CLI (`op`) wurde nicht gefunden.',
                hint: 'Installieren, oder den Spike ohne 1Password starten — dann wird wieder gefragt.',
                context,
            });

        case 'locked':
            return new AppError('CREDENTIALS_LOCKED', {
                message: '1Password ist gesperrt oder nicht angemeldet.',
                hint: 'Einmal `op signin` ausführen, oder die App-Integration in 1Password aktivieren.',
                context,
            });

        case 'item-missing':
            return new AppError('CREDENTIALS_NOT_FOUND', {
                message: `1Password findet "${config.item}" im Tresor "${config.vault}" nicht.`,
                hint: 'Tresor- und Eintragsname prüfen — beide sind exakt zu schreiben.',
                context,
            });

        default:
            break;
    }

    // op's own wording is more use than a paraphrase, and it does not contain the secret.
    const firstLine = stderr.trim().split('\n')[0];
    return new AppError('CREDENTIALS_NOT_FOUND', {
        message: `1Password konnte ${label} nicht liefern.`,
        ...(firstLine === undefined || firstLine === '' ? {} : { hint: `op meldet: ${firstLine}` }),
        context,
    });
}
