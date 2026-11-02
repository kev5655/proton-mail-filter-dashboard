// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountProvider, isLocked, type AccountStatus } from '../src/account.js';
import { App } from '../src/App.js';
import { LockScreen } from '../src/components/LockScreen.js';
import { LockButton } from '../src/components/LockButton.js';

/**
 * Whether the dashboard is behind a password, and — more importantly — when it must not be.
 *
 * The failure this file exists for is the second one. A gate that errs towards locking looks
 * cautious and is not: a password field in front of a server that has no account asks somebody to
 * type a password that does not exist. Three separate states all mean „not locked" and all of them
 * look alike unless they are kept apart: no server, a server without an account surface, and an
 * answer that has not arrived yet.
 *
 * „Not locked" is no longer the same as „show the dashboard". With no server there is no mailbox
 * either, so the gate says so — see the last block. That used to be the demo mailbox, which is why
 * a locked account could produce a complete dashboard full of invented mail.
 */

const OPEN: AccountStatus = {
    available: false,
    registered: false,
    unlocked: true,
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 0,
    withinGrace: false,
    ready: true,
};

describe('when the lock screen appears', () => {
    it('does not, before the server has answered', () => {
        expect(isLocked(OPEN, false, false)).toBe(false);
    });

    it('does not, when no server answered at all', () => {
        // Nothing here is encrypted and nothing is being withheld — there is simply nothing.
        // `NoServerScreen` is what that state gets; „gesperrt" would be a claim about a key.
        expect(isLocked(OPEN, true, false)).toBe(false);
    });

    it('does not, when the server has no account surface', () => {
        // `available: false` and `registered: false` look identical if you only read the second —
        // and reading only the second put a registration form in front of a served mailbox.
        expect(isLocked({ ...OPEN, available: false, registered: false }, true, true)).toBe(false);
    });

    it('does, when there is an account surface and no account yet', () => {
        expect(isLocked({ ...OPEN, available: true, registered: false }, true, true)).toBe(true);
    });

    it('does, when there is an account and it is locked', () => {
        expect(
            isLocked({ ...OPEN, available: true, registered: true, unlocked: false }, true, true)
        ).toBe(true);
    });

    it('does not, once it is unlocked', () => {
        expect(
            isLocked({ ...OPEN, available: true, registered: true, unlocked: true }, true, true)
        ).toBe(false);
    });
});

let container: HTMLDivElement;
let root: Root;
/** Every body this fake server hands back, in order. */
let answers: Array<{ status: number; body: unknown }>;
/** Every account action the page sent — the record that shows what a click actually did. */
let sent: Array<Record<string, unknown>>;
let asked: string[];

function serve(status: Partial<AccountStatus>): void {
    answers = [{ status: 200, body: { ...OPEN, ...status } }];
}

async function mount(node: React.ReactNode): Promise<void> {
    await act(async () => {
        root.render(<AccountProvider>{node}</AccountProvider>);
    });
}

function findText(pattern: RegExp | string): boolean {
    const text = container.textContent ?? '';
    return typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
}

function button(name: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
        (element) => (element.textContent ?? '').trim() === name
    );
    if (found === undefined) {
        throw new Error(`no button „${name}" — buttons: ${[...container.querySelectorAll('button')].map((element) => element.textContent).join(' | ')}`);
    }
    return found as HTMLButtonElement;
}

function field(label: string): HTMLInputElement {
    const found = [...container.querySelectorAll('label')].find((element) =>
        (element.querySelector('span')?.textContent ?? '').trim() === label
    );
    const input = found?.querySelector('input');
    if (input === null || input === undefined) {
        throw new Error(`no field „${label}"`);
    }
    return input;
}

/** Typing, the way React sees it: set the value, then dispatch the event it listens for. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    answers = [];
    sent = [];
    asked = [];

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        asked.push(String(url));
        if (!String(url).startsWith('/api/account')) {
            throw new Error('no server');
        }
        if (init?.method === 'POST') {
            sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        }
        const next = answers.shift() ?? { status: 200, body: OPEN };
        return { ok: next.status < 400, status: next.status, json: async () => next.body } as Response;
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
});

describe('the first run', () => {
    it('asks for a password to create, and says there is no way back from losing it', async () => {
        serve({ available: true, registered: false, unlocked: false });

        await mount(<LockScreen />);

        expect(findText('Konto anlegen')).toBe(true);
        expect(findText(/keine Wiederherstellung/)).toBe(true);
    });

    it('will not create anything until both passwords match', async () => {
        serve({ available: true, registered: false, unlocked: false });
        await mount(<LockScreen />);

        await type(field('Benutzername oder E-Mail'), 'kevin');
        await type(field('Passwort'), 'lang-genug-hoffentlich');
        await type(field('Passwort wiederholen'), 'etwas-anderes');

        expect(button('Konto anlegen').disabled).toBe(true);
        expect(findText('stimmen nicht überein')).toBe(true);
        expect(sent).toEqual([]);
    });
});

describe('unlocking', () => {
    it('shows the server’s own refusal rather than inventing one', async () => {
        serve({ available: true, registered: true, unlocked: false });
        answers.push({
            status: 401,
            body: { error: 'Das Passwort stimmt nicht.', code: 'ACCOUNT_PASSWORD_WRONG' },
        });
        await mount(<LockScreen />);

        await type(field('Passwort'), 'falsch');
        await act(async () => {
            button('Aufschliessen').click();
        });

        expect(findText('Das Passwort stimmt nicht.')).toBe(true);
    });

    it('never puts the password in a URL, where it would end up in a log', async () => {
        serve({ available: true, registered: true, unlocked: false });
        answers.push({ status: 401, body: { error: 'Das Passwort stimmt nicht.' } });
        await mount(<LockScreen />);

        await type(field('Passwort'), 'ein-sehr-eigenes-passwort');
        await act(async () => {
            button('Aufschliessen').click();
        });

        // In the body of a POST and nowhere else. A query string survives in access logs, in shell
        // history and in a screenshot of a browser's address bar.
        expect(asked.join(' ')).not.toContain('ein-sehr-eigenes-passwort');
        expect(sent[0]).toMatchObject({ action: 'unlock', password: 'ein-sehr-eigenes-passwort' });
    });

    it('asks for the second factor only when the account has one', async () => {
        serve({ available: true, registered: true, unlocked: false });
        await mount(<LockScreen />);
        expect(findText('Code aus der Authenticator-App')).toBe(false);

        await act(async () => {
            root.unmount();
        });
        root = createRoot(container);
        serve({ available: true, registered: true, unlocked: false, requiresTotp: true });
        await mount(<LockScreen />);

        expect(findText('Code aus der Authenticator-App')).toBe(true);
    });

    it('offers the way back in while the key is still held, and says the connection survives', async () => {
        serve({ available: true, registered: true, unlocked: false, withinGrace: true });
        await mount(<LockScreen />);

        expect(findText(/Verbindung zu Proton besteht weiter/)).toBe(true);
        await act(async () => {
            button('Weiter ohne Passwort').click();
        });

        expect(sent).toEqual([{ action: 'resume' }]);
    });

    it('says a passkey is a second factor, not a replacement for the password', async () => {
        serve({ available: true, registered: true, unlocked: false, hasPasskeys: true });
        await mount(<LockScreen />);

        expect(findText(/ersetzt es nicht/)).toBe(true);
        // Offered only alongside a password, never on its own.
        expect(button('Passwort und Passkey').disabled).toBe(true);
    });
});

describe('logging out', () => {
    /*
     * „Abmelden" used to take the grace period, so it held the key for half an hour, kept the
     * database open and kept the Proton session live. That put the weakening on the button people
     * press most and the strong version behind a settings tab — the wrong way round for a word that
     * means „I am done here".
     *
     * The grace period is still worth having and still exists; it is „Sperren" in the settings,
     * beside „Sofort sperren", where the two intentions are named next to each other.
     */
    it('discards the key immediately rather than taking the grace period', async () => {
        serve({ available: true, registered: true, unlocked: true, graceMinutes: 30 });
        await mount(<LockButton />);

        await act(async () => {
            button('Abmelden').click();
        });

        expect(sent).toEqual([{ action: 'lock', immediate: true }]);
    });

    it('says so on the button, rather than beside it', async () => {
        serve({ available: true, registered: true, unlocked: true, graceMinutes: 30 });
        await mount(<LockButton />);

        // The bubble exists only while the trigger is hovered or focused, and it renders into the
        // document body rather than into the button — see `Hint`, which was moved out of the
        // sidebar's scroll container on purpose.
        await act(async () => {
            container.querySelector('.hint')?.dispatchEvent(new Event('mouseover', { bubbles: true }));
            container.querySelector('.hint')?.dispatchEvent(new MouseEvent('mouseenter'));
        });

        expect(document.body.textContent).toMatch(/sofort verworfen/);
    });

    it('offers nothing when there is nothing open to close', async () => {
        serve({ available: true, registered: true, unlocked: false });
        await mount(<LockButton />);

        expect(container.textContent).toBe('');
    });
});

describe('adding a second Proton account', () => {
    /*
     * There was no way in at all. The registration form appeared only while the installation had
     * *no* account, so once one existed the substrate underneath — a directory, a database, a
     * Proton session and a password per account — was reachable only by deleting the first
     * account's files. The server side was always right; the screen simply had no door.
     */
    it('offers a way to the form once an account already exists', async () => {
        serve({ available: true, registered: true, unlocked: false });

        await mount(<LockScreen />);

        expect(findText('Ein weiteres Konto anlegen')).toBe(true);
    });

    it('says the open account will be closed, and that nothing carries over', async () => {
        serve({ available: true, registered: true, unlocked: false });
        await mount(<LockScreen />);

        await act(async () => {
            button('Ein weiteres Konto anlegen').click();
        });

        expect(findText('Weiteres Konto anlegen')).toBe(true);
        // The consequence belongs on the screen that performs it: unlocking as somebody else *is*
        // the switch, so creating an account closes the one that is open.
        expect(findText(/wird beim Anlegen geschlossen/)).toBe(true);
        expect(findText(/eigenes Verzeichnis/)).toBe(true);
    });

    it('can be backed out of without creating anything', async () => {
        serve({ available: true, registered: true, unlocked: false });
        await mount(<LockScreen />);

        await act(async () => {
            button('Ein weiteres Konto anlegen').click();
        });
        await act(async () => {
            button('Zurück').click();
        });

        expect(findText('Aufschliessen')).toBe(true);
        expect(sent).toEqual([]);
    });

    it('does not offer it on a first run, where there is nothing to add to', async () => {
        serve({ available: true, registered: false, unlocked: false });

        await mount(<LockScreen />);

        expect(findText('Ein weiteres Konto anlegen')).toBe(false);
    });
});

describe('the whole application', () => {
    it('says there is no server rather than showing a mailbox there is no server for', async () => {
        // The state Kevin was stuck in, from the other direction. This used to be the demo: a
        // complete, plausible dashboard, with no lock screen and nothing on it that led anywhere.
        answers = [];
        vi.stubGlobal('fetch', async (url: string) => {
            asked.push(String(url));
            throw new Error('no server');
        });

        await mount(<App />);

        expect(findText('Kein Server erreichbar')).toBe(true);
        expect(findText('pnpm serve')).toBe(true);
    });

    it('never asks for a mailbox it has been told is locked', async () => {
        serve({ available: true, registered: true, unlocked: false });

        await mount(<App />);

        expect(findText('Anmelden')).toBe(true);
        // The point of putting the gate above `MailboxProvider`: a locked server answers 423 to
        // this, and asking anyway would spend a request on an answer that cannot be used.
        expect(asked.some((url) => url.includes('/api/mailbox'))).toBe(false);
    });
});
