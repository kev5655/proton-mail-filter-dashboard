// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountProvider, isLocked, type AccountStatus } from '../src/account.js';
import { App } from '../src/App.js';
import { LockScreen } from '../src/components/LockScreen.js';

/**
 * Whether the dashboard is behind a password, and — more importantly — when it must not be.
 *
 * The failure this file exists for is the second one. A gate that errs towards locking looks
 * cautious and is not: the demo mailbox has nothing worth guarding, and a password field in front
 * of it asks somebody to type a password that no account has. Three separate states all mean „show
 * the dashboard" and all of them look alike unless they are kept apart: no server, a server without
 * an account surface, and an answer that has not arrived yet.
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
        // The demo. Nothing here is encrypted and nothing is being withheld.
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

describe('the whole application', () => {
    it('never asks for a mailbox it has been told is locked', async () => {
        serve({ available: true, registered: true, unlocked: false });

        await mount(<App />);

        expect(findText('Anmelden')).toBe(true);
        // The point of putting the gate above `MailboxProvider`: a locked server answers 423 to
        // this, and a dashboard that asked anyway would fall back to the demo and show it behind
        // the lock screen.
        expect(asked.some((url) => url.includes('/api/mailbox'))).toBe(false);
    });
});
