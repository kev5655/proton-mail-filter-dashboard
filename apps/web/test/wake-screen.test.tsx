// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { shouldOfferWake } from '../src/power.js';

/**
 * Whether the dashboard offers to start the machine — and, mostly, when it must not.
 *
 * The failure this file exists for is offering it to somebody who has no machine. A silent `/api`
 * with no starter behind it means no server at all — nothing to start, and a button that starts
 * something which does not exist is worse than no button. So two things have to be true at once,
 * and the second one has to come from the host rather than from this browser's memory of it.
 *
 * The second trap is subtler and is why the probe checks the *shape* of the answer. In development
 * vite serves the application shell for any path it does not recognise, so `/starter/status` can
 * come back `200` with HTML — a response that is emphatically not a starter saying anything, and
 * which read as "not running" would put the button in front of every developer.
 */

describe('when the wake screen appears', () => {
    it('does not, before the starter has answered', () => {
        expect(shouldOfferWake(false, 'unknown', false)).toBe(false);
    });

    it('does not, when there is no starter at all', () => {
        // No server and no host answering for one. Nobody here has a machine to wake.
        expect(shouldOfferWake(false, 'absent', true)).toBe(false);
    });

    it('does not, while the server is answering', () => {
        expect(shouldOfferWake(true, 'running', true)).toBe(false);
    });

    it('does not, when the API is silent but the starter says it is running', () => {
        // Something is wrong, but starting an already-running service is not the fix, and a wake
        // screen would hide the fault behind a button that appears to do nothing.
        expect(shouldOfferWake(false, 'running', true)).toBe(false);
    });

    it('does, when the API is silent and the starter says it is stopped', () => {
        expect(shouldOfferWake(false, 'stopped', true)).toBe(true);
    });
});

let container: HTMLDivElement;
let root: Root;
/** What the fake host answers for /starter/status. */
let starter: { status: number; body: unknown } | undefined;
let posted: string[];

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    starter = undefined;
    posted = [];

    /*
     * happy-dom has no `EventSource`, and the negative cases here render the dashboard — which
     * opens the sync stream. Stubbed locally rather than in the shared setup: a global stub would
     * silently swallow a real stream in some future test that meant to check one.
     */
    vi.stubGlobal(
        'EventSource',
        class {
            addEventListener(): void {}
            close(): void {}
        }
    );

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (path.startsWith('/starter/')) {
            if (init?.method === 'POST') {
                posted.push(path);
                return { ok: true, status: 202, json: async () => ({ started: true }) } as Response;
            }
            if (starter === undefined) {
                throw new Error('nothing listening');
            }
            return {
                ok: starter.status < 400,
                status: starter.status,
                json: async () => starter?.body,
            } as Response;
        }
        // The server is what is stopped, so it answers nothing at all.
        throw new Error('no server');
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
    await act(async () => {
        root.render(<App />);
    });
    // The probe resolves on a later tick than the first render.
    await act(async () => {
        await Promise.resolve();
    });
}

describe('the wake screen, rendered', () => {
    it('offers to start when the starter reports a stopped service', async () => {
        starter = { status: 200, body: { running: false, known: true } };

        await mount();

        expect(container.textContent).toContain('Der Server ist angehalten');
        expect(container.textContent).toContain('Server starten');
    });

    it('says that starting grants nothing', async () => {
        starter = { status: 200, body: { running: false, known: true } };

        await mount();

        // Somebody who wakes this has not thereby opened anything, and the screen has to say so —
        // otherwise a button that reveals a mailbox is what it looks like.
        expect(container.textContent).toMatch(/gesperrt hoch/);
    });

    it('does not appear when nothing answers /starter/status', async () => {
        starter = undefined;

        await mount();

        expect(container.textContent).not.toContain('Der Server ist angehalten');
    });

    it('does not appear when the answer is not a starter', async () => {
        // vite's application shell, served for a path it does not know. `200`, and meaningless.
        starter = { status: 200, body: { nothing: 'to do with a starter' } };

        await mount();

        expect(container.textContent).not.toContain('Der Server ist angehalten');
    });

    it('asks the host to start, and only then', async () => {
        starter = { status: 200, body: { running: false, known: true } };
        await mount();

        expect(posted).toEqual([]);

        const start = [...container.querySelectorAll('button')].find(
            (element) => (element.textContent ?? '').trim() === 'Server starten'
        );
        await act(async () => {
            start?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        expect(posted).toEqual(['/starter/start']);
    });
});
