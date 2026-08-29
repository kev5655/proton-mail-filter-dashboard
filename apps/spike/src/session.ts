import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { loginWithBrowser } from '@pms/browser-auth';
import { AppError, isAppError } from '@pms/core/errors';
import {
    getFolders,
    loadSession,
    LoginGuard,
    ProtonHttp,
    refreshSession,
    saveSession,
    type LoginAttemptState,
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
 *
 * The login itself runs in a real browser. Proton's login carries an anti-abuse challenge that only
 * their own page can produce, and an HTTP client without it is refused with code 2028 whatever the
 * credentials are. See `@pms/browser-auth` for why imitating that challenge is not the answer.
 */

const SESSION_FILE = join(DATA_DIR, 'session.enc.json');
const GUARD_FILE = join(DATA_DIR, 'login-attempts.json');

/**
 * Mark an account lock as resolved, after the owner has signed in at mail.proton.me.
 *
 * Returns the state that was cleared, or undefined when there was no lock to clear — the caller
 * says so rather than reporting a success that did nothing.
 */
export async function clearLockout(): Promise<LoginAttemptState | undefined> {
    return new LoginGuard({ path: GUARD_FILE }).clearLockout();
}

const VERSION = '0.1.0';

function newHttp(): ProtonHttp {
    const appVersion = process.env['PROTON_APP_VERSION'];
    // Deliberately slower than the network allows. See ProtonHttp's minIntervalMs.
    const minInterval = Number(process.env['PMS_MIN_REQUEST_INTERVAL_MS'] ?? NaN);
    return new ProtonHttp({
        version: VERSION,
        ...(appVersion === undefined ? {} : { appVersion }),
        ...(Number.isFinite(minInterval) ? { minIntervalMs: minInterval } : {}),
    });
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

    const source = resolveSource(credentialConfig());
    console.log(`Zugangsdaten aus: ${source.name}`);

    // Taken from the vault when it has one, so the whole login is a single fingerprint and the key
    // can be a long random string nobody has to remember. Falling back to a prompt keeps the tool
    // usable without 1Password.
    const fromVault = await source.getSessionPassphrase();
    const passphrase =
        fromVault ??
        (await terminal.askRequiredSecret(
            'Passphrase für die gespeicherte Sitzung (nur lokal, frei wählbar): ',
            'Passphrase'
        ));

    if (fromVault !== undefined) {
        console.log('Sitzungs-Passphrase aus 1Password übernommen.');
    }

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

    // Both are fetched and verified before the first request. If either is empty or malformed this
    // throws here, and Proton never sees a login attempt it would have to count as a failure.
    const username = await source.getUsername();
    const password = await source.getPassword();

    const browser = browserOptions();
    console.log(`Anmeldung über ${describeBrowser(browser)}`);
    warnAboutLiveProfile(browser.profileDir);

    let session: ProtonSession;
    let userId: string;
    try {
        const result = await loginWithBrowser({
            username,
            password,
            ...browser,
            promptTotp: async () => {
                const stored = await source.getTotp();
                if (stored !== undefined) {
                    console.log('  2FA-Code aus 1Password übernommen.');
                    return stored;
                }
                return terminal.askRequiredSecret('2FA-Code: ', '2FA-Code');
            },
        });
        session = result.session;
        userId = result.userId;
    } catch (error) {
        await guard.recordFailure(error);
        throw error;
    }

    http.setSession(session);

    await guard.recordSuccess();
    await persist(session, userId, passphrase);
    console.log('✓ Angemeldet. Die Sitzung ist gespeichert — der nächste Lauf braucht keinen Login.\n');
    return { http, freshLogin: true };
}

interface BrowserChoice {
    headless: boolean;
    channel?: 'chrome' | 'msedge' | 'chromium' | undefined;
    profileDir?: string | undefined;
}

const CHANNELS = new Set(['chrome', 'msedge', 'chromium']);

/**
 * Which browser signs in, and whether it remembers having done so.
 *
 * All three are off by default. A downloaded Chromium with a throwaway profile is the choice that
 * touches least on this machine; the others trade some of that away for a browser Proton is more
 * likely to recognise, which is the whole difficulty here.
 */
function browserOptions(): BrowserChoice {
    const channel = process.env['PMS_BROWSER_CHANNEL'];
    const profile = process.env['PMS_BROWSER_PROFILE'];

    if (channel !== undefined && !CHANNELS.has(channel)) {
        throw new AppError('BROWSER_NOT_INSTALLED', {
            message: `PMS_BROWSER_CHANNEL="${channel}" ist keiner der bekannten Browser.`,
            hint: `Möglich sind: ${[...CHANNELS].join(', ')}. Ohne die Variable wird das mitgelieferte Chromium verwendet.`,
            context: { channel },
        });
    }

    return {
        headless: process.env['PMS_BROWSER_HEADLESS'] !== 'false',
        ...(channel === undefined ? {} : { channel: channel as BrowserChoice['channel'] }),
        ...(profile === undefined || profile === ''
            ? {}
            : { profileDir: resolve(profile.replace(/^~(?=\/|$)/, homedir())) }),
    };
}

/** Profiles a browser you actually use. Driving one of these is not the same as borrowing it. */
const LIVE_PROFILES = ['.config/google-chrome', '.config/chromium', '.config/microsoft-edge'];

function warnAboutLiveProfile(profileDir: string | undefined): void {
    if (profileDir === undefined) {
        return;
    }
    if (LIVE_PROFILES.some((known) => profileDir.startsWith(join(homedir(), known)))) {
        console.log(
            '\n  Achtung: das ist dein echtes Browser-Profil. Chrome muss dafür geschlossen sein,\n' +
                '  und der automatisierte Start kann Einstellungen darin verändern. Ein eigenes\n' +
                '  Verzeichnis (z. B. data/browser-profile) ist die sicherere Wahl.\n'
        );
    }
}

function describeBrowser(choice: BrowserChoice): string {
    const which = choice.channel === undefined ? 'das mitgelieferte Chromium' : `den installierten ${choice.channel}`;
    const window = choice.headless ? 'unsichtbar' : 'mit sichtbarem Fenster';
    const profile =
        choice.profileDir === undefined
            ? 'Profil wird nach der Anmeldung verworfen'
            : `Profil bleibt in ${choice.profileDir}`;
    return `${which}, ${window}. ${profile}.`;
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
