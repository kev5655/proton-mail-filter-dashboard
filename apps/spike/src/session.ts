import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { loginByHandInBrowser, loginWithBrowser } from '@pms/browser-auth';
import { AppError, isAppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import {
    deleteSession,
    getFolders,
    loadSession,
    LoginGuard,
    ProtonHttp,
    refreshSession,
    revokeSession,
    saveSession,
    type LoginAttemptState,
    type ProtonSession,
    type StoredSession,
} from '@pms/proton-api';

import type { CredentialSource } from '@pms/credentials';

import { credentialConfig, resolveSource } from './credentials.js';
import { DATA_DIR, REPO_ROOT } from './paths.js';
import { terminal } from './prompt.js';

const log = getLogger('session');

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
    /**
     * The passphrase protecting everything this tool keeps on this machine.
     *
     * One value for the session tokens and for the mailbox copy, because they are the same kind of
     * thing: local state that is worthless to an attacker who cannot decrypt it and replaceable if
     * lost. It is a separate value from the Proton password, which protects the account itself.
     */
    passphrase: string;
}

/**
 * The passphrase for everything this tool keeps on this machine.
 *
 * Its own function because the server needs it without needing Proton: it opens the mirrored
 * database and never authenticates against the account at all. Going through `connect()` for it
 * would have meant a login path in a program that must not have one.
 */
export async function resolvePassphrase(): Promise<string> {
    return (await openCredentials()).passphrase;
}

/**
 * The credential source, and the passphrase taken from it.
 *
 * Both come back together because announcing the source twice in one run reads as two separate
 * lookups, and because asking 1Password twice means two fingerprints for one command.
 */
async function openCredentials(): Promise<{ source: CredentialSource; passphrase: string }> {
    const source = resolveSource(credentialConfig());
    console.log(`Zugangsdaten aus: ${source.name}`);

    // Taken from the vault when it has one, so the whole login is a single fingerprint and the key
    // can be a long random string nobody has to remember. Falling back to a prompt keeps the tool
    // usable without 1Password.
    const fromVault = await source.getSessionPassphrase();
    if (fromVault !== undefined) {
        console.log('Sitzungs-Passphrase aus 1Password übernommen.');
        return { source, passphrase: fromVault };
    }

    const passphrase = await terminal.askRequiredSecret(
        'Passphrase für die gespeicherte Sitzung (nur lokal, frei wählbar): ',
        'Passphrase'
    );
    return { source, passphrase };
}

/**
 * Pick up a stored session, and under no circumstances start a new one.
 *
 * This is what the server does after somebody unlocks the dashboard, and the difference from
 * `connect()` is the whole reason it exists. `connect()` will, as a last resort, spend a login —
 * the expensive thing, the one `LoginGuard` rations and the one that earned this account a lockout
 * when a program did it on every start. Unlocking a dashboard must never be able to cause one.
 *
 * So: a stored session is reused and refreshed if it needs it, and anything else comes back as
 * `signedIn: false`. The client is then a client with no session, which refuses every request
 * rather than sending an unauthenticated one — and the dashboard offers a „Anmelden" button, which
 * is a person deciding to spend a login rather than a side effect of typing a password.
 */
export async function resume(passphrase: string): Promise<{ http: ProtonHttp; signedIn: boolean }> {
    const http = newHttp();
    const stored = await loadSession(SESSION_FILE, passphrase);
    if (stored === undefined) {
        return { http, signedIn: false };
    }
    return { http, signedIn: await reuse(http, stored, passphrase) };
}

export async function connect(): Promise<Connection> {
    const guard = new LoginGuard({ path: GUARD_FILE });
    const http = newHttp();

    const { source, passphrase } = await openCredentials();

    // Said before anything else, and only when something was actually configured.
    //
    // The browser settings used to be reported inside the login branch, so a run that reused its
    // session — the good case, and the common one — printed nothing about them. "Did my .env take
    // effect?" then had no answer short of forcing a login, which is the one thing this program
    // exists to avoid. Silence when nothing is set keeps the ordinary run quiet.
    reportBrowserSettings();

    const stored = await loadSession(SESSION_FILE, passphrase);
    if (stored !== undefined) {
        const reused = await reuse(http, stored, passphrase);
        if (reused) {
            console.log('✓ Gespeicherte Sitzung wiederverwendet — keine Anmeldung nötig.\n');
            return { http, freshLogin: false, passphrase };
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
    return { http, freshLogin: true, passphrase };
}

/** Whether the user configured any of it, as opposed to accepting every default. */
function browserSettingsPresent(): boolean {
    return ['PMS_BROWSER_CHANNEL', 'PMS_BROWSER_HEADLESS', 'PMS_BROWSER_PROFILE'].some(
        (name) => process.env[name] !== undefined && process.env[name] !== ''
    );
}

function reportBrowserSettings(): void {
    if (!browserSettingsPresent()) {
        return;
    }
    console.log(`Browser-Einstellungen: ${describeBrowser(browserOptions())}`);
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
            : { profileDir: resolve(REPO_ROOT, profile.replace(/^~(?=\/|$)/, homedir())) }),
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

/**
 * The browser settings actually in force, each with the variable that would change it.
 *
 * Naming the variables is the point. The previous version described the outcome only, so a setting
 * that had not been picked up — a `.env` in the wrong directory, a line still commented out —
 * looked exactly like a setting that had been picked up and ignored, and there was no way to tell
 * from the output which of the two it was.
 */
function describeBrowser(choice: BrowserChoice): string {
    const which =
        choice.channel === undefined
            ? 'das mitgelieferte Chromium (PMS_BROWSER_CHANNEL nicht gesetzt)'
            : `den installierten ${choice.channel} (PMS_BROWSER_CHANNEL)`;
    const window = choice.headless
        ? 'unsichtbar (PMS_BROWSER_HEADLESS ist nicht "false")'
        : 'mit sichtbarem Fenster (PMS_BROWSER_HEADLESS=false)';
    const profile =
        choice.profileDir === undefined
            ? 'Profil wird nach der Anmeldung verworfen (PMS_BROWSER_PROFILE nicht gesetzt)'
            : `Profil bleibt in ${choice.profileDir} (PMS_BROWSER_PROFILE)`;
    return `${which}, ${window}.\n  ${profile}.`;
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
            // The whole message, not just the code. A failed refresh means the next run logs in,
            // and a login is the expensive thing here — so the one line that says why must carry
            // enough to fix it without spending another attempt.
            console.log(`  (Erneuern fehlgeschlagen: [${error.code}] ${error.message})`);
            if (error.hint !== undefined && error.hint !== '') {
                console.log(`   → ${error.hint}`);
            }
            const context = describeContext(error.context);
            if (context !== undefined) {
                console.log(`   Kontext: ${context}`);
            }
        }
        return false;
    }
}

/**
 * The error's context as one line, or nothing.
 *
 * `AppError` context is built to be safe to show — `validate.ts` describes values rather than
 * quoting them — but a diagnostic must never be the reason a run falls over, so a context that
 * will not serialise is simply left out.
 */
function describeContext(context: unknown): string | undefined {
    if (context === undefined || context === null) {
        return undefined;
    }
    try {
        const line = JSON.stringify(context);
        return line === '{}' ? undefined : line;
    } catch {
        return undefined;
    }
}

async function persist(session: ProtonSession, userId: string, passphrase: string): Promise<void> {
    await saveSession(
        SESSION_FILE,
        { session, userId, createdAt: Math.floor(Date.now() / 1000) },
        passphrase
    );
}

/**
 * Sign in through a browser window the user drives themselves.
 *
 * The whole point is what this does not touch. `connect()` fetches the username and password out of
 * 1Password and hands them to Playwright to type; this fetches nothing and types nothing. It opens
 * Proton's own login page in a real browser profile and waits — so a password manager's browser
 * extension can fill the form exactly as it would on any other site, and a passkey works because
 * the credential lives in that profile's own store.
 *
 * It is therefore the only mode in which the 1Password extension exists at all, and it needs what
 * an extension needs: a visible window and a persistent profile. Both are refused up front rather
 * than left to fail obscurely after several minutes of waiting.
 *
 * `LoginGuard` is asked first and is not weakened. A button in a web interface makes a login easy
 * to hammer, which is exactly how this account earned a lockout — so a refusal comes back as a
 * refusal, with its reason, and nothing here retries.
 */
export async function loginInBrowser(options: {
    passphrase: string;
    profileDir: string;
    channel?: 'chrome' | 'msedge' | 'chromium' | undefined;
    onOpen?: () => void;
    /**
     * The client that should end up holding the new session.
     *
     * Storing the tokens and not handing them to the running process would produce a sign-in that
     * takes effect at the *next* start — which is exactly the shape of the bug this file's own
     * comments warn about in the other direction, where deleting the file left a live client
     * working. A session lives in memory; putting it there is part of signing in.
     */
    http?: ProtonHttp | undefined;
}): Promise<void> {
    const guard = new LoginGuard({ path: GUARD_FILE });
    await guard.assertMayAttempt();

    const resolved = resolve(REPO_ROOT, options.profileDir.replace(/^~(?=\/|$)/, homedir()));
    warnAboutLiveProfile(resolved);

    let session: ProtonSession;
    let userId: string;
    try {
        const result = await loginByHandInBrowser({
            profileDir: resolved,
            ...(options.channel === undefined ? {} : { channel: options.channel }),
            ...(options.onOpen === undefined ? {} : { onOpen: options.onOpen }),
        });
        session = result.session;
        userId = result.userId;
    } catch (error) {
        await guard.recordFailure(error);
        throw error;
    }

    options.http?.setSession(session);
    await guard.recordSuccess();
    await persist(session, userId, options.passphrase);
}

/** What the guard currently allows, so a dashboard can say why rather than offer a refused button. */
export async function loginGuardState(): Promise<{
    mayAttempt: boolean;
    reason?: string | undefined;
    code?: string | undefined;
}> {
    try {
        await new LoginGuard({ path: GUARD_FILE }).assertMayAttempt();
        return { mayAttempt: true };
    } catch (error) {
        return {
            mayAttempt: false,
            reason: error instanceof Error ? error.message : 'Unbekannt.',
            ...(error !== null && typeof error === 'object' && 'code' in error
                ? { code: String((error as { code: unknown }).code) }
                : {}),
        };
    }
}

export interface SignOutResult {
    /** True when Proton was asked to end the session and answered. */
    revoked: boolean;
    /** Set when the revoke was attempted and failed — reported, never swallowed. */
    revokeError?: string | undefined;
}

/**
 * Sign out, in the order that makes it mean something.
 *
 * Deleting the stored file is the obvious step and on its own it does almost nothing: the tokens
 * live in `ProtonHttp`'s memory from the one `loadSession` at startup, so a running server would
 * keep syncing on its timer and would keep being able to write. A sign-out that looks like security
 * and is not would be worse than no button at all.
 *
 * So the order is the feature, and each step is where it is for a reason:
 *
 *  1. **Stop the timer first** — otherwise an automatic sync can start while this is running, and
 *     it would hold a session that is about to be revoked out from under it.
 *  2. **Revoke while the tokens still exist.** It is the only step that needs them, and it is the
 *     only one that reaches Proton. Its failure is recorded and does not abort the rest: a token
 *     that stays alive is exactly the state we were in before asking, whereas stopping here would
 *     leave the file on disk as well.
 *  3. **Clear the client.** `ProtonHttp` refuses every non-anonymous request without a session, so
 *     from here the process cannot touch the account at all — not even to be rejected. That refusal
 *     had to be added: clearing the session used to leave the client sending unauthenticated
 *     requests that Proton answered 401, which is a pointless request to a service this project is
 *     deliberately polite to, and made "signed out" a weaker statement than it reads as.
 *  4. **Delete the file last.** `reuse()` re-persists after a refresh, so removing it while a live
 *     token still exists can bring it back.
 *
 * `LoginGuard` is deliberately untouched. It counts *failed* attempts; signing out on purpose is
 * not one, and a lockout must not be clearable by pressing a button labelled something else.
 */
export async function signOut(options: {
    http: ProtonHttp;
    /** Also end the session at Proton, not only forget it here. */
    everywhere: boolean;
    /** Stop anything that would keep using the session while this runs. */
    stopBackgroundWork?: (() => void) | undefined;
}): Promise<SignOutResult> {
    options.stopBackgroundWork?.();

    let revoked = false;
    let revokeError: string | undefined;

    if (options.everywhere) {
        try {
            await revokeSession(options.http);
            revoked = true;
        } catch (error) {
            revokeError = error instanceof Error ? error.message : 'Unbekannter Fehler.';
            log.warn(
                { code: isAppError(error) ? error.code : undefined },
                'the session could not be revoked at Proton'
            );
        }
    }

    options.http.setSession(undefined);
    await deleteSession(SESSION_FILE);

    return { revoked, ...(revokeError === undefined ? {} : { revokeError }) };
}
