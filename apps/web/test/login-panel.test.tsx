// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LoginPanel } from '../src/components/LoginPanel.js';

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
