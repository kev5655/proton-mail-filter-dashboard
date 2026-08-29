import { createOnePasswordSource, requirePassword, requireUsername, type CredentialSource } from '@pms/credentials';

import { terminal } from './prompt.js';

/**
 * Where the Proton credentials come from.
 *
 * 1Password when it is configured, the terminal otherwise. Both go through the same verification in
 * `@pms/credentials/verify`, because the failure that matters — a credential that is silently empty
 * — is not specific to either. It happened with the prompt, and a mistyped vault field would do the
 * same thing.
 */

export interface CredentialConfig {
    vault: string | undefined;
    item: string;
}

/**
 * Read from the environment so the vault name is not baked into a public repository, and so the
 * tool works unchanged for someone whose vault is called something else.
 */
export function credentialConfig(): CredentialConfig {
    return {
        vault: process.env['PMS_OP_VAULT'],
        item: process.env['PMS_OP_ITEM'] ?? 'Proton',
    };
}

const PROMPT_SOURCE_NAME = 'Terminal-Eingabe';

export function promptSource(): CredentialSource {
    const origin = (label: string): { source: string; label: string } => ({
        source: PROMPT_SOURCE_NAME,
        label,
    });
    return {
        name: PROMPT_SOURCE_NAME,
        async getUsername() {
            return requireUsername(
                await terminal.ask('Proton-Benutzername (E-Mail): '),
                origin('Benutzername')
            );
        },
        async getPassword() {
            return requirePassword(
                await terminal.askSecret('Passwort (Eingabe unsichtbar): '),
                origin('Passwort')
            );
        },
        async getTotp() {
            return undefined; // Asked for only if Proton actually requires it.
        },
    };
}

export function resolveSource(config: CredentialConfig): CredentialSource {
    if (config.vault === undefined || config.vault === '') {
        return promptSource();
    }
    return createOnePasswordSource({ vault: config.vault, item: config.item });
}
