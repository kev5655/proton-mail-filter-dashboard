// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LockScreen } from '../src/components/LockScreen.js';
import { AccountProvider, type AccountStatus } from '../src/account.js';

/**
 * What the lock screen offers, and what it refuses to assume.
 *
 * Two failures, and they pull in opposite directions.
 *
 * The first is the one that happened. A passkey registered before it could be released for
 * unlocking is a second factor, `passkeyUnlock` is false, and the screen offered no passkey button
 * and no reason — so a working passkey read as a broken one, with nowhere on screen to go. The way
 * through is real and needs saying: unlock once with the password, then release it in the settings,
 * because a passkey must not be able to enrol itself.
 *
 * The second is the opposite temptation. This page is reachable by anybody who can reach the port,
 * so leading with „angemeldet wird als <name>" hands a stranger the account's name for having done
 * nothing but load it. The name appears only where this browser has opened the account before.
 */

const LOCKED: AccountStatus = {
    available: true,
    registered: true,
    unlocked: false,
    requiresTotp: false,
    hasPasskeys: false,
    passkeys: [],
    graceMinutes: 0,
    withinGrace: false,
    ready: false,
    username: 'kevin@example.com',
};

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    try {
        window.localStorage.clear();
    } catch {
        // happy-dom always has it; a browser that refuses storage reads as unknown, which is the
        // case every test here wants except the one that sets it.
    }
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
});

async function mount(status: Partial<AccountStatus>): Promise<void> {
    vi.stubGlobal('fetch', () =>
        Promise.resolve(
            new Response(JSON.stringify({ ...LOCKED, ...status }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        )
    );
    const next = createRoot(container);
    root = next;
    await act(async () => {
        next.render(
            <AccountProvider>
                <LockScreen />
            </AccountProvider>
        );
    });
}

function buttonNames(): string[] {
    return [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
}

function text(): string {
    return container.textContent ?? '';
}

describe('when a passkey can open the account', () => {
    it('offers it first, and puts the password one click away', async () => {
        await mount({ hasPasskeys: true, passkeyUnlock: true });

        const names = buttonNames();
        expect(names[0]).toBe('Mit Passkey aufschliessen');
        // Not merely present: the password field is not on screen until it is asked for.
        expect(container.querySelector('input[type="password"]')).toBeNull();
        expect(names).toContain('Stattdessen Passwort eingeben');
    });

    it('never removes the way in without the authenticator', async () => {
        // An authenticator left at home must not be a lock-out. One click, and the password is back.
        await mount({ hasPasskeys: true, passkeyUnlock: true });

        const fallback = [...container.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === 'Stattdessen Passwort eingeben'
        );
        act(() => {
            fallback?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(container.querySelector('input[type="password"]')).not.toBeNull();
    });
});

describe('when the passkey is only a second factor', () => {
    it('says so, and says what to do about it', async () => {
        // The whole bug: this used to be an empty space where a passkey button should have been.
        await mount({ hasPasskeys: true, passkeyUnlock: false });

        expect(text()).toContain('nur der zweite Faktor');
        expect(text()).toContain('Ohne Passwort aufschliessen');
        expect(container.querySelector('input[type="password"]')).not.toBeNull();
    });

    it('does not offer a passkey-only unlock that would be refused', async () => {
        await mount({ hasPasskeys: true, passkeyUnlock: false });

        expect(buttonNames()).not.toContain('Mit Passkey aufschliessen');
    });
});

describe('who it takes the visitor for', () => {
    it('does not name the account to a browser that has never opened it', async () => {
        await mount({ hasPasskeys: true, passkeyUnlock: true });

        expect(text()).not.toContain('kevin@example.com');
    });

    it('names it once this browser has opened it before', async () => {
        window.localStorage.setItem('pms.device.known', '1');

        await mount({ hasPasskeys: true, passkeyUnlock: true });

        expect(text()).toContain('kevin@example.com');
    });

    it('asks for a name rather than listing accounts, where there is more than one', async () => {
        window.localStorage.setItem('pms.device.known', '1');

        await mount({ needsAccountName: true, hasPasskeys: false, passkeyUnlock: false });

        // Nothing account-shaped, even on a known device: which of them is still unproven.
        expect(text()).not.toContain('kevin@example.com');
        expect(text()).toContain('mehr als ein Konto');
    });
});
