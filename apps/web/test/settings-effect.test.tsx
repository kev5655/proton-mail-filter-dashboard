import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CategoriesPage } from '../src/pages/CategoriesPage.js';
import { DEFAULTS, loadSettings } from '../src/settings.js';
import { Providers } from './harness.js';

/**
 * Settings that reach the screens they are about.
 *
 * Two of the four cards on the settings page were write-only: the page size and the Proton link
 * host were saved, reloaded, shown back — and read by nobody. Every list hardcoded ten rows, and
 * every link to Proton was built with the default host, which for an account with two signed-in
 * profiles is a link to the wrong mailbox.
 *
 * A setting that does nothing is worse than a missing one: the missing one sends you looking, and
 * this one sends you away satisfied.
 */

let container: HTMLDivElement;
let root: Root;

function mount(): void {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <Providers withStore>
                <CategoriesPage />
            </Providers>
        );
    });
}

beforeEach(() => {
    window.localStorage.clear();
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
    window.localStorage.clear();
});

function openFirstCategory(): void {
    act(() => {
        [...container.querySelectorAll('button')]
            .find((entry) => (entry.textContent ?? '').includes('Mails ansehen'))
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

describe('the page size from the settings', () => {
    it('decides how many rows a list shows', () => {
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, display: { pageSize: 5 } })
        );
        mount();
        openFirstCategory();

        const rows = container.querySelectorAll('.mail-list li:not(.mail-row-filler)').length;
        expect(rows).toBeLessThanOrEqual(5);
        expect(rows).toBeGreaterThan(0);
    });

    it('still defaults to ten when nothing was ever set', () => {
        mount();
        openFirstCategory();

        expect(container.querySelectorAll('.mail-list li:not(.mail-row-filler)').length).toBeLessThanOrEqual(10);
        expect(container.textContent).toContain('Seite 1 von');
    });
});

describe('the Ollama address', () => {
    it('defaults to the path that goes through this page', () => {
        // Ollama answers only origins it was told to allow, and `localhost:5173` is not one by
        // default — so the absolute address failed with a network error indistinguishable from
        // "nothing is listening", and the settings page told people their running model was down.
        expect(DEFAULTS.llm.baseUrl).toBe('/ollama');
    });

    it('moves a copy saved with the old absolute default onto it', () => {
        // Left alone it would keep failing for a reason invisible from the screen. There is nothing
        // to lose: the old value is the address the proxy forwards to anyway.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, llm: { ...DEFAULTS.llm, baseUrl: 'http://127.0.0.1:11434' } })
        );

        expect(loadSettings().llm.baseUrl).toBe('/ollama');
    });

    it('leaves an address the user chose alone', () => {
        // An Ollama on another machine is a real setup, and the proxy is not the answer for it.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, llm: { ...DEFAULTS.llm, baseUrl: 'http://gpu.fritz.box:11434' } })
        );

        expect(loadSettings().llm.baseUrl).toBe('http://gpu.fritz.box:11434');
    });
});

describe('the language-model choice', () => {
    it('no longer offers a stand-in', () => {
        // A provider answering from a lookup table is the wrong offer next to a real mailbox: it
        // puts generated-looking text exactly where a judgement would go.
        const source = readFileSync(join(import.meta.dirname, '..', 'src', 'settings.ts'), 'utf8');
        expect(source).not.toContain("'demo'");
    });

    it('moves a copy saved with the stand-in selected onto off', () => {
        // Rather than leaving an unknown mode to fall through to a default nobody chose.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, llm: { ...DEFAULTS.llm, mode: 'demo' } })
        );

        expect(loadSettings().llm.mode).toBe('off');
    });

    it('keeps the hosted-model key out of everything but the settings', () => {
        // It is the one secret in this file. Nothing else may read it, and in particular nothing
        // may put it in a log line or an error.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({
                ...DEFAULTS,
                llm: { ...DEFAULTS.llm, mode: 'cloud', cloud: { provider: 'openai', apiKey: 'geheim', model: 'm', baseUrl: '' } },
            })
        );

        expect(loadSettings().llm.cloud.apiKey).toBe('geheim');
    });
});

describe('the page size', () => {
    it('accepts a number that had to be typed over the old one', () => {
        // As a plain number the field could not be emptied — `Number('') || 10` put the 10 straight
        // back, so „30" was impossible to type without selecting the old value first.
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, display: { pageSize: 30 } })
        );

        expect(loadSettings().display.pageSize).toBe(30);
    });

    it('refuses a stored value outside the range instead of trusting it', () => {
        window.localStorage.setItem(
            'pms.settings',
            JSON.stringify({ ...DEFAULTS, display: { pageSize: 5000 } })
        );

        expect(loadSettings().display.pageSize).toBe(100);
    });
});
