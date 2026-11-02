// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountProvider } from '../src/account.js';
import { MailboxProvider } from '../src/mailbox.js';

/**
 * What the dashboard does when there is no mailbox to show.
 *
 * This is the half of `MailboxProvider` the harness cannot reach, and it is the half that used to
 * be wrong. Every non-`200` was treated as „no server" and answered with a synthetic mailbox — so a
 * **423, the locked vault**, produced a working dashboard full of invented mail. Somebody whose
 * account had merely locked was shown somebody else's folders and given no way back.
 *
 * Three rules, each checked below: nothing renders the children without a mailbox; a locked vault
 * says it is locked and offers the way back to the lock screen; a refused connection says the
 * server is not running rather than quietly standing in for one.
 */

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
    vi.unstubAllGlobals();
});

/** Mount the provider against a `/api/mailbox` that answers however this test needs. */
async function mount(answer: () => Promise<Response>): Promise<void> {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => (url === '/api/mailbox' ? answer() : Promise.reject(new TypeError('kein Server'))))
    );
    const next = createRoot(container);
    root = next;
    await act(async () => {
        next.render(
            <AccountProvider>
                <MailboxProvider>
                    <p>DASHBOARD-HIER</p>
                </MailboxProvider>
            </AccountProvider>
        );
    });
}

describe('when the mirror cannot be read', () => {
    it('does not render the dashboard on a locked vault', async () => {
        await mount(() => Promise.resolve(new Response('{"error":"gesperrt"}', { status: 423 })));

        // The whole bug, in one assertion. This used to be a complete dashboard.
        expect(container.textContent).not.toContain('DASHBOARD-HIER');
    });

    it('says the vault is locked, and offers the way back to the lock screen', async () => {
        await mount(() => Promise.resolve(new Response('{}', { status: 423 })));

        expect(container.textContent).toContain('Gesperrt');
        expect(container.textContent).toContain('Passwort');
        expect(container.textContent).toContain('Zum Sperrbildschirm');
    });

    it('says the server is not running when the connection is refused', async () => {
        await mount(() => Promise.reject(new TypeError('Failed to fetch')));

        expect(container.textContent).not.toContain('DASHBOARD-HIER');
        expect(container.textContent).toContain('pnpm serve');
    });

    it('reports any other status rather than standing in for it', async () => {
        await mount(() => Promise.resolve(new Response('nope', { status: 500 })));

        expect(container.textContent).not.toContain('DASHBOARD-HIER');
        expect(container.textContent).toContain('500');
        expect(container.textContent).toContain('Noch einmal versuchen');
    });
});

describe('when it can', () => {
    it('renders the dashboard, and only then', async () => {
        await mount(() =>
            Promise.resolve(
                new Response(
                    JSON.stringify({
                        messages: [],
                        folders: [],
                        rules: [],
                        unreadable: [],
                        meta: { syncedAt: 1_700_000_000, version: 'v1', truncated: false },
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                )
            )
        );

        expect(container.textContent).toContain('DASHBOARD-HIER');
    });
});
