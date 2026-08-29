import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { Browser, BrowserContext, Page, Response } from 'playwright';

import {
    AUTH_PATH,
    PROTON_LOGIN_URL,
    SELECTORS,
    TOTP_SWITCH_PATTERNS,
    type SelectorName,
} from './selectors.js';

const log = getLogger('browser-auth');

/**
 * Sign in to Proton through a real browser.
 *
 * Proton's login carries an anti-abuse challenge — a `Payload` of device and behaviour telemetry
 * collected by their own script in the page. An HTTP client cannot produce one, and Proton answers
 * a login without it with code 2028, "unusual activity targeting your account", even when the
 * credentials are correct and the same account signs in through a browser at that moment.
 *
 * The answer is not to imitate that payload. There is no specification for it, a wrong one is a
 * worse signal than none, and forging an anti-abuse control is the thing this project does not do.
 * So the login happens in a browser that really is one: Proton's page runs Proton's script, the
 * challenge is genuine, and nothing here has to pretend. It also makes a passkey possible at all —
 * WebAuthn needs an authenticator, which no Node HTTP client has.
 *
 * The browser exists for the login and nothing else. Everything afterwards is the ordinary API
 * client, carrying the session captured here.
 *
 * The password is typed into the page and never leaves this function: not logged, not returned, not
 * attached to an error. Only the resulting tokens come back.
 */

export interface BrowserSession {
    uid: string;
    accessToken: string;
    refreshToken: string;
    /** What the browser would send, as a `Cookie` header value. */
    cookies: string;
}

export interface BrowserLoginResult {
    session: BrowserSession;
    userId: string;
}

export interface BrowserLoginOptions {
    username: string;
    password: string;
    /** Asked for only when Proton requests a code, so no one is prompted needlessly. */
    promptTotp: () => Promise<string>;
    /**
     * Run without a visible window. A passkey needs a visible one — a headless browser has no
     * authenticator to touch — so a FIDO2-only account must set this to false.
     */
    headless?: boolean;
    /**
     * Use a browser already installed on this machine instead of the one Playwright downloaded.
     *
     * `chrome` is the real Google Chrome. It matters for a passkey: the credential lives in the
     * browser's own store or is reached over hybrid transport, and Playwright's bundled Chromium is
     * a different browser with a different store. It is also, simply, an ordinary browser doing an
     * ordinary thing, which is the whole idea.
     */
    channel?: 'chrome' | 'msedge' | 'chromium' | undefined;
    /**
     * Keep the browser profile in this directory instead of throwing it away.
     *
     * Worth knowing before switching it on. In favour: Proton recognises a device it has seen
     * before and asks fewer questions, which is the entire problem here. Against: the profile holds
     * cookies in Chrome's own store, which this project does not encrypt the way it encrypts the
     * session file — so it is opt-in, and it belongs somewhere git-ignored.
     *
     * Do not point this at a profile Chrome is currently using. Playwright needs the profile to
     * itself and will refuse.
     */
    profileDir?: string | undefined;
    timeoutMs?: number;
    loginUrl?: string;
    /** Injected in tests, so the flow can be exercised without launching anything. */
    launch?: () => Promise<Browser>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Bitfield on Proton's auth response. */
const TWO_FACTOR_TOTP = 1;
const TWO_FACTOR_FIDO2 = 2;

/**
 * What `core/v4/auth` returns to a browser.
 *
 * Deliberately not the token-bearing shape. Proton's web login runs in cookie mode: the response
 * carries the identity and the outcome, and the tokens arrive as `Set-Cookie` instead. Requiring
 * `AccessToken` here was the mistake that made a successful login look like a broken one.
 */
interface AuthPayload {
    UID: string;
    UserID: string;
    TwoFactor: number;
}

function isAuthPayload(value: unknown): value is AuthPayload {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate['UID'] === 'string' &&
        typeof candidate['UserID'] === 'string' &&
        typeof candidate['TwoFactor'] === 'number'
    );
}

export async function loginWithBrowser(options: BrowserLoginOptions): Promise<BrowserLoginResult> {
    const headless = options.headless ?? true;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const launched = await launchBrowser(options, headless);
    const { browser, context } = launched;
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(timeout);

        const seen = traceAuthRequests(page);
        const auth = watchForAuthResponse(page, seen);

        await page.goto(options.loginUrl ?? PROTON_LOGIN_URL, { waitUntil: 'domcontentloaded' });

        await fill(page, 'username', options.username);
        await fill(page, 'password', options.password);
        await click(page, 'submit');

        const payload = await withTimeout(
            auth,
            timeout,
            'Proton hat auf die Anmeldung nicht mit einer Sitzung geantwortet.',
            seen
        );

        const pending = payload.TwoFactor !== 0;

        if ((payload.TwoFactor & TWO_FACTOR_TOTP) !== 0) {
            await revealTotpField(page, headless, timeout);
            await fill(page, 'totp', await options.promptTotp());
            await click(page, 'submit');
        } else if ((payload.TwoFactor & TWO_FACTOR_FIDO2) !== 0 && headless) {
            // A passkey needs something to touch, and a headless browser offers nothing.
            throw new AppError('BROWSER_LOGIN_2FA_UNSUPPORTED', {
                message: 'Dieses Konto verlangt einen Passkey, und der Browser läuft unsichtbar.',
                hint:
                    'Mit sichtbarem Fenster starten, dann lässt sich der Passkey bestätigen — oder ' +
                    'in Proton zusätzlich TOTP einrichten.',
                context: { twoFactor: payload.TwoFactor },
            });
        } else if ((payload.TwoFactor & TWO_FACTOR_FIDO2) !== 0) {
            console.log('\n  Bitte den Passkey im Browser-Fenster bestätigen. Danach geht es von selbst weiter.\n');
        }

        // Waiting for the session cookie rather than for a particular request.
        //
        // The first version watched `core/v4/auth/2fa` and hung on a passkey, because Proton
        // confirms one some other way. Which call completes a second factor is Proton's business
        // and changes; that the session cookie exists is the thing actually being waited for, and
        // it is true however the login finished.
        const session = await collectSession(context, payload.UID, pending ? timeout : Math.min(timeout, 20_000));
        log.info({ userId: payload.UserID, twoFactor: payload.TwoFactor }, 'signed in through a browser');
        return { session, userId: payload.UserID };
    } finally {
        await context.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
    }
}

/**
 * Take the session out of the browser's cookie jar once the login has settled.
 *
 * Proton names them `AUTH-<UID>` and `REFRESH-<UID>`. The whole jar is kept as well: it is exactly
 * what the browser would send, and it does not depend on those names being right forever.
 *
 * The cookies are set on the response to `core/v4/auth`, but a `Set-Cookie` is applied slightly
 * after the response arrives, so this waits rather than reading once and giving up.
 */
async function collectSession(context: BrowserContext, uid: string, timeoutMs: number): Promise<BrowserSession> {
    const deadline = Date.now() + timeoutMs;
    let names: string[] = [];

    for (;;) {
        const jar = (await context.cookies()).filter((cookie) => cookie.domain.endsWith('proton.me'));
        names = jar.map((cookie) => cookie.name);

        const access = jar.find((cookie) => cookie.name === `AUTH-${uid}`);
        const refresh = jar.find((cookie) => cookie.name === `REFRESH-${uid}`);

        if (access !== undefined) {
            return {
                uid,
                accessToken: access.value,
                refreshToken: refresh?.value ?? '',
                cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
            };
        }
        if (Date.now() > deadline) {
            break;
        }
        await new Promise((done) => setTimeout(done, 200));
    }

    throw new AppError('BROWSER_LOGIN_UI_CHANGED', {
        message: `Das Sitzungs-Cookie "AUTH-${uid}" ist nicht aufgetaucht.`,
        hint:
            `Vorhanden sind: ${names.join(', ') || '(keine)'} — nur die Namen, die Werte sind die ` +
            'Sitzung selbst. Entweder war die Anmeldung im Fenster nicht fertig (zweiter Faktor?), ' +
            'oder Proton hat die Cookies umbenannt; das Letztere ist in collectSession anzupassen.',
        context: { uid, cookieNames: names },
    });
}

interface Launched {
    /** Undefined for a persistent profile: there the context owns the browser. */
    browser: Browser | undefined;
    context: BrowserContext;
}

async function launchBrowser(options: BrowserLoginOptions, headless: boolean): Promise<Launched> {
    if (options.launch !== undefined) {
        const browser = await options.launch();
        return { browser, context: await browser.newContext() };
    }

    const channel = options.channel;
    try {
        const { chromium } = await import('playwright');

        if (options.profileDir !== undefined) {
            // A persistent profile *is* the context; there is no separate browser to close.
            const context = await chromium.launchPersistentContext(options.profileDir, {
                headless,
                ...(channel === undefined ? {} : { channel }),
            });
            return { browser: undefined, context };
        }

        // Otherwise a throwaway profile: nothing is written anywhere the next login can find.
        const browser = await chromium.launch({ headless, ...(channel === undefined ? {} : { channel }) });
        return { browser, context: await browser.newContext() };
    } catch (cause) {
        throw new AppError('BROWSER_NOT_INSTALLED', {
            message:
                channel === undefined
                    ? 'Der Browser für die Anmeldung liess sich nicht starten.'
                    : `Der installierte Browser "${channel}" liess sich nicht starten.`,
            hint:
                channel === undefined
                    ? 'Einmalig `pnpm exec playwright install chromium` ausführen.'
                    : 'Ist er installiert? Und läuft er gerade mit demselben Profil — Playwright ' +
                      'braucht das Profil für sich allein.',
            context: { headless, channel, profileDir: options.profileDir },
            cause,
        });
    }
}

/**
 * Take the session straight from Proton's answer, rather than digging it out of the page afterwards.
 *
 * The response to `core/v4/auth` is where the tokens exist in plain form; a moment later they are
 * cookies with their own rules. Reading them here means the handover does not depend on any of the
 * app's internals.
 */
function watchForAuthResponse(page: Page, seen: AuthTrace): Promise<AuthPayload> {
    return new Promise<AuthPayload>((resolve, reject) => {
        page.on('response', (response: Response) => {
            if (!matches(response, AUTH_PATH) || !response.ok()) {
                return;
            }
            response
                .json()
                .then((body: unknown) => {
                    if (isAuthPayload(body)) {
                        resolve(body);
                        return;
                    }
                    reject(unexpectedAuthResponse(body, seen));
                })
                .catch(reject);
        });
    });
}

/**
 * Every auth-ish request the page made, by path and status only.
 *
 * Proton's production login can be ahead of the client source this project is pinned to, so "the
 * response was not what we expected" is not necessarily about the response — it may be that the
 * call we watched is no longer the one that matters. Recording the sequence turns the next run into
 * an answer instead of another guess, and each run costs the account owner something.
 */
type AuthTrace = Array<{ path: string; status: number }>;

function traceAuthRequests(page: Page): AuthTrace {
    const seen: AuthTrace = [];
    page.on('response', (response: Response) => {
        const { pathname } = new URL(response.url());
        if (response.request().method() === 'POST' && pathname.includes('/auth')) {
            seen.push({ path: pathname, status: response.status() });
        }
    });
    return seen;
}

/**
 * Say what came back, by field name.
 *
 * Names only, never values — the same rule the rest of the project follows, and here it costs
 * nothing: which fields exist is the entire diagnosis, and one of them is an access token.
 */
function unexpectedAuthResponse(body: unknown, seen: AuthTrace): AppError {
    const fields =
        body !== null && typeof body === 'object' ? Object.keys(body as Record<string, unknown>).sort() : [];
    const expected = ['UID', 'UserID', 'TwoFactor'];
    const missing = expected.filter((name) => !fields.includes(name));

    return new AppError('BROWSER_LOGIN_UI_CHANGED', {
        message: `Protons Anmeldeantwort hat nicht die erwarteten Felder. Es fehlen: ${missing.join(', ')}.`,
        hint:
            `Zurückgekommen sind: ${fields.length === 0 ? '(kein Objekt)' : fields.join(', ')}. ` +
            'Nur die Namen — Werte werden bewusst nicht ausgegeben. Damit lässt sich anpassen, ' +
            'ohne einen weiteren Anmeldeversuch zu verbrauchen.',
        context: { endpoint: AUTH_PATH, fields, missing, authRequests: seen },
    });
}

function matches(response: Response, path: string): boolean {
    return response.request().method() === 'POST' && new URL(response.url()).pathname === path;
}

/**
 * Get Proton's second-factor screen onto the authenticator-code option.
 *
 * It opens on the passkey, with the code field not rendered at all, so reaching straight for the
 * field finds nothing — which is exactly what happened, and it read as "Proton changed their page".
 *
 * Three steps, weakest assumption last. If the field is already there, nothing to do. Otherwise
 * click whatever is labelled like a switch to the code method — a guess, and a cheap one, because a
 * wrong click costs nothing here. Finally just wait: with a visible window the person is right
 * there, and one click from them beats a selector that has to keep being right.
 */
async function revealTotpField(page: Page, headless: boolean, timeoutMs: number): Promise<void> {
    if (await appears(page, 1_500)) {
        return;
    }

    for (const pattern of TOTP_SWITCH_PATTERNS) {
        try {
            const control = page.getByRole('button', { name: pattern }).first();
            if ((await control.count()) > 0) {
                await control.click({ timeout: 2_000 });
                if (await appears(page, 2_000)) {
                    return;
                }
            }
        } catch {
            // A guess that did not land. The wait below is the part that is meant to work.
        }
    }

    if (headless) {
        throw new AppError('BROWSER_LOGIN_2FA_UNSUPPORTED', {
            message: 'Protons 2FA-Seite zeigt den Passkey, und das Code-Feld liess sich nicht öffnen.',
            hint:
                'Unsichtbar kann das niemand umschalten. Mit PMS_BROWSER_HEADLESS=false starten — ' +
                'dann genügt ein Klick im Fenster und der Code wird selbst eingetragen.',
            context: { selector: SELECTORS.totp },
        });
    }

    console.log(
        '\n  Proton fragt nach dem Passkey. Bitte im Fenster auf den Authentifizierungscode\n' +
            '  umschalten — den Code trägt der Spike dann selbst ein.\n'
    );
    try {
        await page.waitForSelector(SELECTORS.totp, { state: 'visible', timeout: timeoutMs });
    } catch (cause) {
        throw new AppError('BROWSER_LOGIN_TIMEOUT', {
            message: 'Es wurde nicht auf den Authentifizierungscode umgeschaltet.',
            hint: `Gewartet wurde auf \`${SELECTORS.totp}\`. Heisst das Feld inzwischen anders, steht es in selectors.ts.`,
            context: { selector: SELECTORS.totp, timeoutMs },
            cause,
        });
    }
}

async function appears(page: Page, timeoutMs: number): Promise<boolean> {
    try {
        await page.waitForSelector(SELECTORS.totp, { state: 'visible', timeout: timeoutMs });
        return true;
    } catch {
        return false;
    }
}

async function fill(page: Page, name: SelectorName, value: string): Promise<void> {
    const selector = SELECTORS[name];
    try {
        await page.fill(selector, value);
    } catch (cause) {
        throw uiChanged(name, selector, cause);
    }
}

async function click(page: Page, name: SelectorName): Promise<void> {
    const selector = SELECTORS[name];
    try {
        await page.click(selector);
    } catch (cause) {
        throw uiChanged(name, selector, cause);
    }
}

/**
 * A missing element is a changed login page, and saying so is the whole point.
 *
 * Without this the failure is a Playwright timeout mentioning a CSS selector, which reads like a
 * network problem. Naming the field and the file to edit turns it into a five-minute fix.
 */
function uiChanged(name: SelectorName, selector: string, cause: unknown): AppError {
    return new AppError('BROWSER_LOGIN_UI_CHANGED', {
        message: `Auf Protons Anmeldeseite ist das Feld "${name}" nicht mehr zu finden.`,
        hint: `Erwartet wurde \`${selector}\`. Proton hat die Seite geändert — anzupassen in packages/browser-auth/src/selectors.ts.`,
        context: { field: name, selector },
        cause,
    });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string, seen?: AuthTrace): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new AppError('BROWSER_LOGIN_TIMEOUT', {
                                message,
                                hint:
                                    'Mit sichtbarem Fenster starten zeigt, woran es hängt — meist eine ' +
                                    'Rückfrage von Proton, die unsichtbar niemand beantwortet.',
                                context: { timeoutMs: ms, ...(seen === undefined ? {} : { authRequests: seen }) },
                            })
                        ),
                    ms
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
