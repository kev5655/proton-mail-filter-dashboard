// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FoldersPage } from '../src/pages/FoldersPage.js';
import { Providers } from './harness.js';

/**
 * Renaming a folder, in the application rather than in a browser prompt.
 *
 * `window.prompt` could not show the one thing that makes a rename consequential: Proton stores a
 * filter's destination as a *name*, so every rule pointing at the folder has to be carried along or
 * it files into a folder that no longer exists — silently, with the mail still leaving the inbox.
 * That is now on screen while the name is still being chosen, not only in the diff afterwards.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <Providers withStore>
                <FoldersPage />
            </Providers>
        );
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
});

function clickFirst(label: string): void {
    act(() => {
        [...container.querySelectorAll('button')]
            .find((entry) => (entry.textContent ?? '').trim() === label)
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

describe('the rename dialog', () => {
    it('opens in the page instead of a browser prompt', () => {
        expect(container.querySelector('[role="dialog"]')).toBeNull();

        clickFirst('Umbenennen');

        const dialog = container.querySelector('[role="dialog"]');
        expect(dialog?.getAttribute('aria-label')).toBe('Ordner umbenennen');
        expect(container.querySelector('input.text-input')).not.toBeNull();
    });

    it('will not stage a name that changes nothing', () => {
        clickFirst('Umbenennen');

        // The field opens on the current name, so the confirming button starts disabled. A rename
        // to the same name would travel the whole route — diff, terminal, write — to do nothing.
        const confirm = [...container.querySelectorAll('button')].find((entry) =>
            (entry.textContent ?? '').includes('Neuen Namen eingeben')
        );
        expect(confirm?.disabled).toBe(true);
    });
});

describe('the browser prompt is gone for good', () => {
    it('appears nowhere under apps/web/src', () => {
        // A grep rather than a render: the point is that no *other* screen quietly keeps using it.
        // `window.confirm` for discarding a local draft is a different question and stays.
        const offenders: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
                    if (/window\.prompt\(|[^.\w]prompt\(/.test(readFileSync(full, 'utf8'))) {
                        offenders.push(full);
                    }
                }
            }
        };
        walk(join(import.meta.dirname, '..', 'src'));

        expect(offenders).toEqual([]);
    });
});
