import { AppError, isAppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';

import type { Reply } from './handler.js';

const log = getLogger('server');

/**
 * The gate in front of everything else, and the only surface a locked tool answers.
 *
 * This is the one place where the usual promise — *HTTP is an offer, not a trigger* — reads
 * differently, and the difference is worth stating rather than glossing. Every other non-GET route
 * either reads at Proton or records something for a person to confirm at a terminal. This one acts:
 * it creates the account, and it unlocks the key that the mailbox database and the stored Proton
 * session are encrypted with.
 *
 * What keeps that defensible is what it *cannot* do. It never reaches Proton — not to read, not to
 * write, not to sign in. It cannot open a database; it can only hand a key to the process that
 * does. And it is served on the loopback interface, where the alternative to a password is no
 * password at all: before this existed, anything on this machine that could reach the port could
 * read the mailbox.
 *
 * Like every other channel here, this file holds no capability of its own. It parses a request and
 * calls functions handed in from outside — `serve-command.ts` assembles them around a `Vault`,
 * which is the only thing in the project that ever holds the key.
 *
 * **The challenge is remembered here, not carried by the client.** A WebAuthn verification that
 * trusted the browser's copy of the challenge it was answering would verify nothing at all.
 */

export interface AccountView {
    /**
     * Whether this server has an account surface at all.
     *
     * `false` is what a server without one answers, and it is the difference between „no account
     * yet, ask for one" and „nothing here guards anything". Without it, a dashboard talking to a
     * server that never had a `Vault` would put a registration form in front of a mailbox it is
     * already being served — which is what the first version of this did.
     */
    available: boolean;
    /** False means this installation has never been set up: the first screen is a registration. */
    registered: boolean;
    unlocked: boolean;
    username?: string | undefined;
    requiresTotp: boolean;
    /** Whether a passkey can be offered as the second factor at the next unlock. */
    hasPasskeys: boolean;
    /**
     * Whether the unlock has to say *which* account.
     *
     * True only where this installation has more than one. Everything else about an account —
     * whether it needs a code, whether it has a passkey — is unknowable until the name is given,
     * and is reported as absent rather than guessed at.
     */
    needsAccountName: boolean;
    passkeys: Array<{ id: string; label: string; addedAt: number }>;
    graceUntil?: number | undefined;
    graceMinutes: number;
    /**
     * The key is still held after a lock, so the way back in costs no password.
     *
     * Shown as its own offer rather than by quietly accepting an empty password: „weiter ohne
     * Passwort" is a sentence somebody can disagree with, and a lock screen that opens on Enter is
     * one nobody would trust twice.
     */
    withinGrace: boolean;
    /**
     * Whether the mailbox is open and the rest of the API can answer.
     *
     * Separate from `unlocked` because unlocking is what *starts* opening the database; for the
     * moment in between, a dashboard that already switched away from the lock screen would show an
     * empty mailbox and call it the account.
     */
    ready: boolean;
    /** Set when opening the mailbox after an unlock failed — otherwise the screen just stays blank. */
    problem?: string | undefined;
}

export interface PasskeyOffer {
    challenge: string;
    options: unknown;
}

/**
 * Everything the account surface can do, handed in rather than reached for.
 *
 * Each one is a `Vault` method plus, for `unlock`, the work of opening the mailbox and picking up a
 * stored Proton session. None of them can be performed by this package.
 */
export interface AccountRunner {
    view: () => AccountView;
    register: (input: { username: string; password: string }) => Promise<void>;
    unlock: (input: {
        password: string;
        totp?: string | undefined;
        passkey?: { response: unknown; challenge: string; origin: string } | undefined;
        /**
         * Which account, when this installation has more than one.
         *
         * Absent means „the only one there is", which is every installation until somebody adds a
         * second. The names are not listed anywhere the server offers: a lock screen that
         * enumerates the accounts tells whoever opened the page which ones exist, and it costs
         * nothing to type the one you came for.
         */
        account?: string | undefined;
    }) => Promise<void>;
    lock: (immediate: boolean) => void;
    /** Come back in while the key is still held. Refused once it is gone. */
    resume: () => Promise<void>;
    /**
     * Grant one pending change, against the app password.
     *
     * On this surface rather than on `/api/apply`, and that placement is the point: a password
     * belongs to the account, and a `ChangeRequest` is digested, journalled and reported. Nothing
     * that carries a password may end up in a record somebody can read back.
     */
    confirmChange: (requestId: string, password: string) => Promise<void>;
    /**
     * Refuse one pending change.
     *
     * No password: saying no proves nothing, and requiring a secret to decline would make waiting
     * the easier way out — which is how a change stays armed while somebody goes to look
     * something up.
     */
    declineChange: (requestId: string) => Promise<void>;
    changePassword: (current: string, next: string) => Promise<void>;
    /** Mint a secret and its otpauth URI. Nothing is stored until a code proves it arrived. */
    beginTotp: () => Promise<{ secret: string; uri: string }>;
    enableTotp: (secret: string, code: string) => Promise<void>;
    disableTotp: (password: string) => Promise<void>;
    beginPasskeyRegistration: (origin: string) => Promise<PasskeyOffer>;
    finishPasskeyRegistration: (input: {
        label: string;
        response: unknown;
        challenge: string;
        origin: string;
    }) => Promise<void>;
    removePasskey: (id: string) => Promise<void>;
    beginPasskeyLogin: (origin: string) => Promise<PasskeyOffer>;
    setGraceMinutes: (minutes: number) => Promise<void>;
}

export class AccountChannel {
    readonly #runner: AccountRunner;
    /** The challenge this server issued, kept so the browser's claim about it is never believed. */
    #outstanding: string | undefined;

    constructor(runner: AccountRunner) {
        this.#runner = runner;
    }

    get view(): AccountView {
        return this.#runner.view();
    }

    /**
     * One request, one action, each named in its own branch.
     *
     * A table of handlers would be shorter and would make adding an eleventh action a matter of
     * adding a line to a list — which is precisely the property the write surface is built to
     * refuse, and this surface holds the key to everything the write surface protects.
     */
    async perform(body: unknown, requestOrigin?: string): Promise<Reply> {
        const input = (body ?? {}) as Record<string, unknown>;
        const action = typeof input['action'] === 'string' ? input['action'] : '';

        /*
         * Which origin WebAuthn is verified against.
         *
         * The request header, not a field in the body. The header is the browser's own account of
         * where the page came from and has already been through `refuseForeignOrigin`; the body is
         * whatever the caller decided to type. Since `rpIdFor` derives the relying-party id from
         * this, a body field meant the caller chose the scope their own credential is bound to —
         * which is the one thing a relying party is not allowed to let them do.
         *
         * The body value remains the fallback, because a request that never reached this server
         * through a browser has no header to offer and there is nothing safer to fall back to.
         */
        const origin = requestOrigin !== undefined && requestOrigin !== '' ? requestOrigin : text(input['origin']);

        try {
            switch (action) {
                case 'register':
                    await this.#runner.register({
                        username: text(input['username']),
                        password: text(input['password']),
                    });
                    return this.#ok();

                case 'unlock': {
                    const passkey = input['passkey'];
                    await this.#runner.unlock({
                        password: text(input['password']),
                        // Trimmed here, so „nothing was typed" and „spaces were typed" are the
                        // same request rather than one of them naming an account that cannot exist.
                        ...(text(input['account']).trim() === ''
                            ? {}
                            : { account: text(input['account']).trim() }),
                        ...(text(input['totp']) === '' ? {} : { totp: text(input['totp']) }),
                        ...(passkey === undefined || passkey === null
                            ? {}
                            : {
                                  passkey: {
                                      response: passkey,
                                      // The server's own challenge. What the browser sent back is
                                      // an answer to a question, not the question.
                                      challenge: this.#take(),
                                      origin,
                                  },
                              }),
                    });
                    return this.#ok();
                }

                case 'lock':
                    this.#runner.lock(input['immediate'] === true);
                    return this.#ok();

                case 'resume':
                    await this.#runner.resume();
                    return this.#ok();

                /*
                 * The second confirmation, which used to be a keystroke at a terminal.
                 *
                 * The exchange is written down in `weigh()`: a password can be produced by
                 * anything that knows it, where a terminal keystroke cannot be produced over HTTP
                 * at all — but the person confirming now sees, at that moment, exactly what is
                 * affected. A confirmation somebody has to walk to another window for is one they
                 * learn to perform without reading, and on a machine with no keyboard at all it
                 * was not a confirmation but a two-minute wait.
                 *
                 * Declining travels the same way and carries no password, because saying no proves
                 * nothing and should cost nothing. Without it the only way to refuse was to let
                 * five minutes pass, which left the change armed for exactly as long as somebody
                 * might walk away from the screen.
                 */
                case 'confirm-change':
                    if (input['decline'] === true) {
                        await this.#runner.declineChange(text(input['requestId']));
                        return this.#ok();
                    }
                    await this.#runner.confirmChange(text(input['requestId']), text(input['password']));
                    return this.#ok();

                case 'change-password':
                    await this.#runner.changePassword(text(input['current']), text(input['next']));
                    return this.#ok();

                case 'totp-begin':
                    return { status: 200, body: await this.#runner.beginTotp() };

                case 'totp-enable':
                    await this.#runner.enableTotp(text(input['secret']), text(input['code']));
                    return this.#ok();

                case 'totp-disable':
                    await this.#runner.disableTotp(text(input['password']));
                    return this.#ok();

                case 'passkey-register-begin': {
                    const offer = await this.#runner.beginPasskeyRegistration(origin);
                    this.#outstanding = offer.challenge;
                    return { status: 200, body: { options: offer.options } };
                }

                case 'passkey-register-finish':
                    await this.#runner.finishPasskeyRegistration({
                        label: text(input['label']),
                        response: input['response'],
                        challenge: this.#take(),
                        origin,
                    });
                    return this.#ok();

                case 'passkey-remove':
                    await this.#runner.removePasskey(text(input['id']));
                    return this.#ok();

                case 'passkey-login-begin': {
                    const offer = await this.#runner.beginPasskeyLogin(origin);
                    this.#outstanding = offer.challenge;
                    return { status: 200, body: { options: offer.options } };
                }

                case 'grace':
                    await this.#runner.setGraceMinutes(Number(input['minutes']));
                    return this.#ok();

                default:
                    return {
                        status: 400,
                        body: {
                            error: `Unbekannte Kontoaktion: ${action === '' ? '(keine)' : action}`,
                            code: 'ACCOUNT_UNKNOWN_ACTION',
                        },
                    };
            }
        } catch (cause) {
            return failure(action, cause);
        }
    }

    #ok(): Reply {
        return { status: 200, body: this.#runner.view() };
    }

    /**
     * The outstanding challenge, consumed.
     *
     * Once, deliberately: a challenge that could answer twice is a challenge a replayed response
     * satisfies. A missing one is a refusal rather than an empty string, which would otherwise be
     * handed to the verifier as if it were a real question.
     */
    #take(): string {
        const challenge = this.#outstanding;
        this.#outstanding = undefined;
        if (challenge === undefined) {
            throw new AppError('ACCOUNT_NO_CHALLENGE', {
                message: 'Zu dieser Antwort gibt es keine offene Anfrage.',
                hint: 'Den Vorgang neu starten. Es wurde nichts geprüft und nichts gespeichert.',
            });
        }
        return challenge;
    }
}

/**
 * A refusal the dashboard can act on, without the log line that would carry it off this machine.
 *
 * `401` for a wrong password or a wrong code, because that is what it is, and the dashboard shows
 * the message rather than inventing one. Nothing about the attempt is logged beyond the action name
 * and the error code: what somebody typed at a password field is exactly the sort of thing this
 * project keeps out of a log file.
 */
function failure(action: string, cause: unknown): Reply {
    const code = isAppError(cause) ? cause.code : 'ACCOUNT_FAILED';
    const status =
        code === 'ACCOUNT_PASSWORD_WRONG' ||
        code === 'ACCOUNT_SECOND_FACTOR_REQUIRED' ||
        code === 'ACCOUNT_SECOND_FACTOR_WRONG'
            ? 401
            : code === 'ACCOUNT_EXISTS' || code === 'ACCOUNT_MISSING' || code === 'ACCOUNT_LOCKED'
              ? 409
              : 400;

    log.warn({ action, code }, 'account action refused');
    return {
        status,
        body: {
            error: cause instanceof Error ? cause.message : 'Unbekannter Fehler.',
            code,
            ...(isAppError(cause) && cause.hint !== undefined ? { hint: cause.hint } : {}),
        },
    };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
