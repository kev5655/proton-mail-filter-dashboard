import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { Browser, BrowserContext, Locator, Page, Response } from 'playwright';

import {
    AUTH_PATH,
    PROTON_LOGIN_URL,
    SELECTORS,
    TOTP_SELECTORS,
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
            const field = await revealTotpField(page, headless, timeout);
            await fillSelector(page, field, await options.promptTotp(), 'Authentifizierungscode');

            // Best effort, deliberately. A six-digit field usually submits itself once it is full,
            // and then there is no button left to press — which is not a failure, it is the form
            // having already done the thing. Whether the login finished is decided below, by the
            // session cookie, not by whether a click landed.
            await clickIfPresent(page, SELECTORS.submit);
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
                    ? 'Einmalig `pnpm install:browser` ausführen — das lädt Chromium herunter. ' +
                      '(`pnpm exec playwright ...` funktioniert nicht: Playwright liegt in einem ' +
                      'Workspace-Paket und ist von der Wurzel aus nicht aufrufbar.)'
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
async function revealTotpField(page: Page, headless: boolean, timeoutMs: number): Promise<string> {
    const quick = await findTotpField(page, 1_500);
    if (quick !== undefined) {
        return quick;
    }

    for (const pattern of TOTP_SWITCH_PATTERNS) {
        for (const candidate of switchCandidates(page, pattern)) {
            try {
                if ((await candidate.count()) === 0) {
                    continue;
                }
                await candidate.first().click({ timeout: 2_000 });
                const revealed = await findTotpField(page, 2_000);
                if (revealed !== undefined) {
                    return revealed;
                }
            } catch {
                // A guess that did not land. The wait below is the part that is meant to work.
            }
        }
    }

    if (headless) {
        // The same diagnosis the visible path gets. Without it this error said only which selectors
        // were tried — which we already knew — and the attempt it cost taught us nothing.
        throw new AppError('BROWSER_LOGIN_2FA_UNSUPPORTED', {
            message: 'Protons 2FA-Seite zeigt den Passkey, und das Code-Feld liess sich nicht öffnen.',
            hint:
                'Unsichtbar kann das niemand umschalten. Mit PMS_BROWSER_HEADLESS=false starten — ' +
                'dann genügt ein Klick im Fenster und der Code wird selbst eingetragen. Was die Seite ' +
                'tatsächlich anbietet, steht im Kontext unter `inputs` und `buttons`; daraus lässt ' +
                'sich packages/browser-auth/src/selectors.ts anpassen, ohne noch einen Versuch zu ' +
                'verbrauchen.',
            context: { tried: [...TOTP_SELECTORS], ...(await describeForm(page)) },
        });
    }

    console.log(
        '\n  Proton fragt nach dem Passkey. Bitte im Fenster auf den Authentifizierungscode\n' +
            '  umschalten — den Code trägt der Spike dann selbst ein.\n'
    );

    const afterHelp = await findTotpField(page, timeoutMs);
    if (afterHelp !== undefined) {
        return afterHelp;
    }

    throw new AppError('BROWSER_LOGIN_TIMEOUT', {
        message: 'Das Feld für den Authentifizierungscode wurde nicht gefunden.',
        hint:
            `Gesucht wurde nach: ${TOTP_SELECTORS.join(', ')}. Was die Seite tatsächlich anbietet, ` +
            `steht im Kontext unter \`inputs\` und \`buttons\` — daraus lässt sich selectors.ts ` +
            'anpassen, ohne noch einen Anmeldeversuch zu verbrauchen.',
        context: { tried: [...TOTP_SELECTORS], ...(await describeForm(page)) },
    });
}

/**
 * The things on the page that might be the switch to the code method, likeliest first.
 *
 * A button by its accessible name is the shape Proton uses today. The other two exist because that
 * assumption has already been wrong once and cost a login attempt to find out: the control may be a
 * link, and Proton's own components sometimes render one as neither — a styled `div` with a click
 * handler, which has no role at all and is reachable only by its text.
 */
function switchCandidates(page: Page, pattern: RegExp): Locator[] {
    return [
        page.getByRole('button', { name: pattern }),
        page.getByRole('link', { name: pattern }),
        page.getByText(pattern),
    ];
}

/** The first candidate that is actually on screen, or undefined. */
async function findTotpField(page: Page, timeoutMs: number): Promise<string | undefined> {
    const each = Math.max(250, Math.floor(timeoutMs / TOTP_SELECTORS.length));
    for (const selector of TOTP_SELECTORS) {
        try {
            await page.waitForSelector(selector, { state: 'visible', timeout: each });
            return selector;
        } catch {
            // Not this one.
        }
    }
    return undefined;
}

/**
 * What the page is offering, in the terms a selector is written in.
 *
 * Attributes and button labels only — never a field's value. Every round of this has cost a login
 * attempt to learn one fact about Proton's markup; this turns the next failure into the answer
 * instead of another round.
 */
async function describeForm(page: Page): Promise<{ inputs: string[]; buttons: string[] }> {
    const attributes = ['type', 'id', 'name', 'autocomplete', 'inputmode', 'placeholder'];
    try {
        const fields = await page.locator('input').all();
        const inputs = await Promise.all(
            fields.map(async (field) => {
                const parts = await Promise.all(
                    attributes.map(async (attribute) => {
                        const value = await field.getAttribute(attribute);
                        return value === null || value === '' ? undefined : `${attribute}=${value}`;
                    })
                );
                const visible = (await field.isVisible()) ? 'visible' : 'hidden';
                return [...parts.filter((part) => part !== undefined), visible].join(' ');
            })
        );

        const controls = await page.locator('button, a[role="button"]').all();
        const buttons = (await Promise.all(controls.map(async (control) => (await control.innerText()).trim())))
            .filter((text) => text !== '')
            .slice(0, 20);

        return { inputs, buttons };
    } catch {
        // Diagnostics must never become the reason a run fails.
        return { inputs: [], buttons: [] };
    }
}

async function fill(page: Page, name: SelectorName, value: string): Promise<void> {
    await fillSelector(page, SELECTORS[name], value, name);
}

async function fillSelector(page: Page, selector: string, value: string, name: string): Promise<void> {
    try {
        await page.fill(selector, value);
    } catch (cause) {
        throw uiChanged(name, selector, cause);
    }
}

async function click(page: Page, name: SelectorName): Promise<void> {
    const selector = SELECTORS[name];
    try {
        // `.first()`: a page may hold several submit buttons, and a bare selector then refuses to
        // choose rather than pressing the obvious one.
        await page.locator(selector).first().click();
    } catch (cause) {
        throw uiChanged(name, selector, cause);
    }
}

/** Press it if it is there. Returns whether it was. */
async function clickIfPresent(page: Page, selector: string): Promise<boolean> {
    try {
        const control = page.locator(selector).first();
        await control.click({ timeout: 3_000 });
        return true;
    } catch {
        log.debug({ selector }, 'nothing to click; the form had moved on');
        return false;
    }
}

/**
 * A missing element is a changed login page, and saying so is the whole point.
 *
 * Without this the failure is a Playwright timeout mentioning a CSS selector, which reads like a
 * network problem. Naming the field and the file to edit turns it into a five-minute fix.
 */
function uiChanged(name: string, selector: string, cause: unknown): AppError {
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

/**
 * Sign in by opening the page and getting out of the way.
 *
 * The difference from `loginWithBrowser` is what this function does *not* do: it never sees a
 * password. It opens Proton's login page and waits. The person types, or their password manager's
 * browser extension fills the form the way it would on any other site, or they touch a passkey —
 * and none of that passes through this process.
 *
 * That is the whole argument for it. `loginWithBrowser` has to be handed the credentials, which
 * means fetching them out of 1Password and holding them in memory here. This version cannot leak
 * what it never receives, and it is the only shape in which a browser extension can participate at
 * all: the extension fills Proton's own form, in a real profile, exactly as if the page had been
 * opened by hand.
 *
 * It follows that this needs a visible window and a profile the extension is installed in. Headless
 * has nobody to type; a throwaway profile has no extension. Both are refused rather than left to
 * fail obscurely several minutes later.
 *
 * The wait is long on purpose — somebody may have to find their phone — and it is bounded, because
 * a browser window left open forever is a browser window nobody closes.
 */
export async function loginByHandInBrowser(options: {
    /** Where the profile lives. Required: an extension cannot exist in a throwaway one. */
    profileDir: string;
    channel?: 'chrome' | 'msedge' | 'chromium' | undefined;
    /** How long the person has. Generous; a second factor can involve looking for a phone. */
    timeoutMs?: number;
    /** Called once the window is up, so a dashboard can say what is waiting for whom. */
    onOpen?: () => void;
}): Promise<BrowserLoginResult> {
    const timeout = options.timeoutMs ?? 5 * 60_000;

    const launched = await launchBrowser(
        { username: '', password: '', promptTotp: async () => '', ...options },
        // Never headless. There is nobody to type in a window that does not exist, and failing
        // here is much cheaper than failing after a five-minute wait for input that cannot come.
        false
    );
    const { browser, context } = launched;
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(timeout);

        const seen = traceAuthRequests(page);
        const auth = watchForAuthResponse(page, seen);

        await page.goto(PROTON_LOGIN_URL, { waitUntil: 'domcontentloaded' });
        options.onOpen?.();

        const payload = await withTimeout(
            auth,
            timeout,
            'Im Browser-Fenster wurde die Anmeldung nicht abgeschlossen.',
            seen
        );

        // Same reasoning as above: the session cookie is what is actually being waited for, and it
        // is true however the login finished — password, passkey, or a code from an app.
        const session = await collectSession(context, payload.UID, timeout);
        log.info({ userId: payload.UserID, twoFactor: payload.TwoFactor }, 'signed in by hand in a browser');
        return { session, userId: payload.UserID };
    } finally {
        await context.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
    }
}
