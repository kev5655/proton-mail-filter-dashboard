// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prf = vi.hoisted(() => ({ supported: true }));

/*
 * The authenticator, and only the authenticator.
 *
 * `passkey.ts` itself is deliberately *not* mocked: converting the salt, reading
 * `clientExtensionResults` and stripping the key material out of the response before it is sent is
 * exactly the part that has to work, and a mock of it would test the test. So the fake stops at the
 * browser API, and PRF support is the one thing it varies.
 */
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

import { AccountSettings } from '../src/components/AccountSettings.js';
import { AccountProvider, type AccountStatus } from '../src/account.js';

/**
 * Registering a passkey makes it the key, where the authenticator can be one.
 *
 * It used not to. Releasing a passkey for unlocking was a second, separate act in a second place,
 * so every passkey on this installation stayed a second factor and the lock screen offered nothing
 * — which is indistinguishable, from the outside, from a passkey that does not work.
 *
 * The rule it must not break is that a passkey cannot enrol *itself*. It does not: this runs from
 * the settings, behind an open vault, which is exactly where the password has already been given.
 */

const OPEN: AccountStatus = {
    available: true,
    registered: true,
    unlocked: true,
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 30,
    withinGrace: false,
    ready: true,
};

let container: HTMLDivElement;
let root: Root | undefined;
let actions: string[];

beforeEach(() => {
    prf.supported = true;
    actions = [];
    container = document.createElement('div');
    document.body.append(container);
    vi.stubGlobal('fetch', (_url: string, init?: { method?: string; body?: string }) => {
        const action =
            init?.method === 'POST' && init.body !== undefined
                ? (JSON.parse(init.body) as { action: string }).action
                : undefined;
        if (action !== undefined) {
            actions.push(action);
        }
        // The offer the server makes for an assertion that is meant to produce key material. Its
        // salt is what `assertWithPrf` converts and hands to the authenticator; without it the
        // module refuses before the authenticator is ever asked.
        const body =
            action === 'passkey-login-begin'
                ? { options: { extensions: { prf: { eval: { first: btoa('a-32-byte-salt-for-the-test-xyz') } } } } }
                : OPEN;
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

async function addPasskey(): Promise<string> {
    const next = createRoot(container);
    root = next;
    await act(async () => {
        next.render(
            <AccountProvider>
                <AccountSettings />
            </AccountProvider>
        );
    });

    const field = [...container.querySelectorAll('input[type="text"]')].find((input) =>
        input.closest('label')?.textContent?.includes('Bezeichnung')
    ) as HTMLInputElement | undefined;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
        setter?.call(field, 'Laptop');
        field?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const add = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Passkey hinzufügen'
    );
    await act(async () => {
        add?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
        await Promise.resolve();
    });

    return container.textContent ?? '';
}

describe('adding a passkey', () => {
    it('releases it for unlocking without being asked', async () => {
        const shown = await addPasskey();

        expect(actions).toContain('passkey-register-finish');
        expect(actions).toContain('passkey-unlock-enable');
        expect(shown).toContain('schliesst ohne Passwort auf');
    });

    it('keeps it as a second factor when the authenticator cannot produce key material', async () => {
        // Not an error and not a failed registration: the passkey exists and works. Reporting this
        // as a refusal is how somebody concludes their hardware is broken.
        prf.supported = false;

        const shown = await addPasskey();

        expect(actions).toContain('passkey-register-finish');
        expect(actions).not.toContain('passkey-unlock-enable');
        expect(shown).toContain('zweiter Faktor');
        expect(shown).toContain('PRF');
    });
});
