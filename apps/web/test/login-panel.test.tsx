// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LoginPanel } from '../src/components/LoginPanel.js';
import { LoginProvider } from '../src/login.js';

/**
 * The sign-in button, and what it is honest about.
 *
 * Two claims have to hold. That no password passes through the page — what opens is Proton's own
 * form in a real browser profile, so a password manager's extension fills it as it would anywhere
 * else. And that a failed attempt is not retried: this account was locked out once by repetition,
 * and a button in a web interface makes repeating easy.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
});

describe('the panel', () => {
    it('shows nothing at all without a provider-backed server', () => {
        // No `pnpm serve`, no login to offer. A dead button is worse than no button.
        expect(() => {
            act(() => {
                root.render(<LoginPanel />);
            });
        }).toThrow(/useLogin outside/);
    });
});

describe('what the screen promises', () => {
    const source = readFileSync(
        join(import.meta.dirname, '..', 'src', 'components', 'LoginPanel.tsx'),
        'utf8'
    );

    it('says the password does not pass through here', () => {
        expect(source).toContain('Hier läuft kein\n                    Passwort durch');
    });

    it('says a failure is not retried, and why', () => {
        // The reason matters as much as the fact. „Wird nicht wiederholt" reads as a limitation;
        // „dieses Konto war einmal gesperrt" reads as the reason it is one.
        expect(source).toContain('nicht</strong> automatisch erneut versucht');
        expect(source).toContain('einmal gesperrt');
    });

    it('offers no button beside a refusal', () => {
        // A refusal from LoginGuard is shown as what it is. Anything that made pressing again easy
        // would undo the thing the guard is for.
        const refusalBlock = source.slice(source.indexOf('refusal !== undefined'));
        expect(refusalBlock).not.toContain('<button');
    });
});

/**
 * A fake event stream, so the panel can be shown the states the server would send.
 *
 * happy-dom has no `EventSource`, and the point of these tests is what the panel does with what
 * arrives on it — which cannot be reached through the source text.
 */
class FakeSource {
    static last: FakeSource | undefined;
    onopen: (() => void) | undefined;
    onerror: (() => void) | undefined;
    onmessage: ((event: { data: string }) => void) | undefined;

    constructor() {
        FakeSource.last = this;
    }
    close(): void {}
    push(state: Record<string, unknown>): void {
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify(state) });
    }
}

async function show(state: Record<string, unknown>): Promise<void> {
    vi.stubGlobal('EventSource', FakeSource);
    await act(async () => {
        root.render(
            <LoginProvider>
                <LoginPanel />
            </LoginProvider>
        );
    });
    await act(async () => {
        FakeSource.last?.push({ state: 'idle', available: true, signedIn: false, ...state });
    });
}

/**
 * The claim in `CLAUDE.md` and in `session-channel.ts`: the dashboard shows the guard's state and
 * the reason, **rather than offering a button that will be refused**.
 *
 * It was not true. `refusal` was only set after the request came back, so the button was offered,
 * pressed, and only then explained — on the one subsystem that has already cost this account a
 * lockout. These tests are what makes the sentence true rather than aspirational.
 */
describe('what the guard forbids, before anything is pressed', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('offers the button when nothing is blocking', async () => {
        await show({});

        expect(button('Bei Proton anmelden')?.disabled).toBe(false);
    });

    it('offers no button at all during an account lock', async () => {
        // No waiting clears this one. A button would be refused every single time, and pressing it
        // repeatedly is precisely how the lockout was earned.
        await show({
            blocked: { reason: 'Konto gesperrt (2028).', lockedOut: true },
        });

        expect(button('Bei Proton anmelden')).toBeUndefined();
        expect(container.textContent).toContain('lockout-cleared');
    });

    it('keeps the button but disables it during a cooldown', async () => {
        // This one ends by itself, so hiding the button would leave somebody wondering whether the
        // tool still works.
        await show({
            blocked: {
                reason: 'Noch 4 Minuten.',
                lockedOut: false,
                retryAfter: Math.floor(Date.now() / 1000) + 240,
            },
        });

        expect(button('Bei Proton anmelden')?.disabled).toBe(true);
        expect(container.textContent).toContain('Noch 4 Minuten.');
    });

    it('re-enables the button once the cooldown has passed', async () => {
        await show({
            blocked: {
                reason: 'War gesperrt.',
                lockedOut: false,
                retryAfter: Math.floor(Date.now() / 1000) - 1,
            },
        });

        expect(button('Bei Proton anmelden')?.disabled).toBe(false);
    });
});

function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((entry) =>
        (entry.textContent ?? '').includes(label)
    );
}
