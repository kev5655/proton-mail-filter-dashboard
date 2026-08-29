import { join } from 'node:path';

import { isAppError } from '@pms/core/errors';
import {
    getFolders,
    loadSession,
    login,
    LoginGuard,
    ProtonHttp,
    refreshSession,
    saveSession,
    type ProtonSession,
    type StoredSession,
} from '@pms/proton-api';

import { credentialConfig, resolveSource } from './credentials.js';
import { DATA_DIR } from './paths.js';
import { terminal } from './prompt.js';

/**
 * Get an authenticated client, logging in only when there is genuinely no other option.
 *
 * The order matters and is the point of this file. Proton locked the account behind this project
 * with code 2028 after a handful of logins, because the spike re-authenticated on every run. A
 * program that logs in on every start is indistinguishable from credential stuffing.
 *
 * So: stored session first, refresh second, and a fresh login only as a last resort — behind a
 * guard that refuses to try again too soon after a failure.
 */

const SESSION_FILE = join(DATA_DIR, 'session.enc.json');
const GUARD_FILE = join(DATA_DIR, 'login-attempts.json');

const VERSION = '0.1.0';

function newHttp(): ProtonHttp {
    const appVersion = process.env['PROTON_APP_VERSION'];
    return new ProtonHttp({ version: VERSION, ...(appVersion === undefined ? {} : { appVersion }) });
}

/** Cheap authenticated call used to find out whether a token still works. */
async function isUsable(http: ProtonHttp): Promise<boolean> {
    try {
        await getFolders(http);
        return true;
    } catch {
        return false;
    }
}

export interface Connection {
    http: ProtonHttp;
    /** True when this run had to authenticate from scratch. */
    freshLogin: boolean;
}

export async function connect(): Promise<Connection> {
    const guard = new LoginGuard({ path: GUARD_FILE });
    const http = newHttp();

    const passphrase = await terminal.askRequiredSecret(
        'Passphrase für die gespeicherte Sitzung (nur lokal, frei wählbar): ',
        'Passphrase'
    );

    const stored = await loadSession(SESSION_FILE, passphrase);
    if (stored !== undefined) {
        const reused = await reuse(http, stored, passphrase);
        if (reused) {
            console.log('✓ Gespeicherte Sitzung wiederverwendet — keine Anmeldung nötig.\n');
            return { http, freshLogin: false };
        }
        console.log('Die gespeicherte Sitzung ist abgelaufen und liess sich nicht erneuern.\n');
    }

    // Only now, and only once.
    await guard.assertMayAttempt();

    const source = resolveSource(credentialConfig());
    console.log(`Zugangsdaten aus: ${source.name}`);

    // Both are fetched and verified before the first request. If either is empty or malformed this
    // throws here, and Proton never sees a login attempt it would have to count as a failure.
    const username = await source.getUsername();
    const password = await source.getPassword();

    let session: ProtonSession;
    let userId: string;
    try {
        const result = await login(http, { username, password }, async () => {
            const stored = await source.getTotp();
            if (stored !== undefined) {
                console.log('  2FA-Code aus 1Password übernommen.');
                return stored;
            }
            return terminal.askRequiredSecret('2FA-Code: ', '2FA-Code');
        });
        session = result.session;
        userId = result.userId;
    } catch (error) {
        await guard.recordFailure(error);
        throw error;
    }

    await guard.recordSuccess();
    await persist(session, userId, passphrase);
    console.log('✓ Angemeldet. Die Sitzung ist gespeichert — der nächste Lauf braucht keinen Login.\n');
    return { http, freshLogin: true };
}

async function reuse(http: ProtonHttp, stored: StoredSession, passphrase: string): Promise<boolean> {
    http.setSession(stored.session);
    if (await isUsable(http)) {
        return true;
    }

    try {
        // Proton rotates the refresh token on every use, so the new one must be written back or the
        // next run finds a session that can no longer be refreshed.
        const refreshed = await refreshSession(http, stored.session);
        await persist(refreshed, stored.userId, passphrase);
        return true;
    } catch (error) {
        if (isAppError(error)) {
            console.log(`  (Erneuern fehlgeschlagen: ${error.code})`);
        }
        return false;
    }
}

async function persist(session: ProtonSession, userId: string, passphrase: string): Promise<void> {
    await saveSession(
        SESSION_FILE,
        { session, userId, createdAt: Math.floor(Date.now() / 1000) },
        passphrase
    );
}
