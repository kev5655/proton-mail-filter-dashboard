// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prf = vi.hoisted(() => ({ supported: true }));

vi.mock('@simplewebauthn/browser', () => ({
    startRegistration: () => Promise.resolve({ id: 'new-credential' }),
    startAuthentication: () =>
        Promise.resolve({
            id: 'new-credential',
            clientExtensionResults: prf.supported
                ? { prf: { results: { first: new Uint8Array(32).fill(7) } } }
                : {},
        }),
}));

import { App } from '../src/App.js';

/**
 * Setting up the account, with a passkey in the same act.
 *
 * The passkey used to be something to find afterwards, in a settings tab, on an account that
 * already worked — so nobody found it, every passkey stayed a second factor, and the lock screen
 * offered no passkey button and no reason. It belongs where the account comes into existence.
 *
 * The password is not replaced and that is deliberate: it is what unwraps the key when the
 * authenticator is not at hand, and it is what the second confirmation before a deletion is checked
 * against. What changes is that the passkey works from the first moment rather than the second day.
 *
 * The awkward part this pins is the screen. Registering *opens* the account, so the gate would
 * normally swap this form for the dashboard the moment the answer lands — mid-ceremony, taking the
 * only place the outcome could be reported with it.
 */

const FRESH = {
    available: true,
    registered: false,
    unlocked: false,
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 30,
    withinGrace: false,
    ready: false,
};

let container: HTMLDivElement;
let root: Root | undefined;
let actions: string[];

beforeEach(() => {
    prf.supported = true;
    actions = [];
    container = document.createElement('div');
    document.body.append(container);

    vi.stubGlobal('fetch', (url: string, init?: { method?: string; body?: string }) => {
        const action =
            init?.method === 'POST' && init.body !== undefined
                ? (JSON.parse(init.body) as { action: string }).action
                : undefined;
        if (action !== undefined) {
            actions.push(action);
        }
        if (String(url).startsWith('/starter')) {
            return Promise.reject(new TypeError('no starter'));
        }
        if (!String(url).startsWith('/api/account')) {
            return Promise.reject(new TypeError('no server'));
        }
        const body =
            action === 'passkey-login-begin'
                ? { options: { extensions: { prf: { eval: { first: btoa('a-32-byte-salt-for-the-test-xyz') } } } } }
                : { ...FRESH, registered: actions.includes('register'), unlocked: actions.includes('register') };
        return Promise.resolve(
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        );
    });
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
});

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

async function fill(label: string, value: string): Promise<void> {
    const input = [...container.querySelectorAll('input')].find((element) =>
        element.closest('label')?.querySelector('span')?.textContent?.includes(label)
    );
    await act(async () => {
        setter?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function openRegistration(): Promise<void> {
    const next = createRoot(container);
    root = next;
    await act(async () => {
        next.render(<App />);
    });
}

async function submit(): Promise<void> {
    const button = [...container.querySelectorAll('button')].find(
        (element) => element.textContent?.trim() === 'Konto anlegen'
    );
    await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The ceremony is several awaits deep; let them all settle before reading the screen.
    for (let round = 0; round < 8; round++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
}

async function register(): Promise<void> {
    await openRegistration();
    await fill('Benutzername', 'kevin');
    await fill('Passwort', 'ein-langes-passwort');
    await fill('Passwort wiederholen', 'ein-langes-passwort');
    await submit();
}

describe('creating the account', () => {
    it('offers a passkey there, and takes it by default', async () => {
        await openRegistration();

        const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(box).not.toBeNull();
        expect(box?.checked).toBe(true);
        expect(container.textContent).toContain('Passkey gleich einrichten');
    });

    it('creates the account and the passkey, and releases it for unlocking', async () => {
        await register();

        expect(actions).toEqual([
            'register',
            'passkey-register-begin',
            'passkey-register-finish',
            'passkey-login-begin',
            'passkey-unlock-enable',
        ]);
    });

    it('holds the screen until the outcome has been acknowledged', async () => {
        // Two things at once. The silent register keeps the gate from swapping this form for the
        // dashboard mid-ceremony, and „Weiter" is what finally lets it — so the sentence cannot be
        // on screen for the length of one render and then gone.
        await register();

        expect(container.textContent).toContain('schliesst ohne Passwort auf');

        const onward = [...container.querySelectorAll('button')].find(
            (element) => element.textContent?.trim() === 'Weiter'
        );
        await act(async () => {
            onward?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(container.textContent).not.toContain('Konto anlegen');
    });

    it('says so when the authenticator cannot be a key, without calling it a failure', async () => {
        prf.supported = false;

        await register();

        expect(actions).toContain('passkey-register-finish');
        expect(actions).not.toContain('passkey-unlock-enable');
        expect(container.textContent).toContain('zweiter Faktor');
        expect(container.textContent).not.toContain('fehlgeschlagen');
    });

    it('creates a plain account when the passkey is declined', async () => {
        await openRegistration();
        const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
        await act(async () => {
            box?.click();
        });
        await fill('Benutzername', 'kevin');
        await fill('Passwort', 'ein-langes-passwort');
        await fill('Passwort wiederholen', 'ein-langes-passwort');
        await submit();

        expect(actions).toEqual(['register']);
    });
});
