// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DiffDialog } from '../src/components/DiffDialog.js';
import { useStore } from '../src/store.js';
import { Providers } from './harness.js';

/**
 * The last screen before a change is offered, and the two sentences on it that have to be true.
 *
 * It used to tell every user, for every change, that „die Rückfrage kommt im Terminal" — and then
 * most changes went through without one, because `weigh` only asks twice for the expensive ones.
 * A sentence that is wrong more often than right is one people learn to skip, which is expensive in
 * a dialog whose entire job is to be read.
 */

let container: HTMLDivElement;
let root: Root;
let store: ReturnType<typeof useStore>;

function Probe(): null {
    store = useStore();
    return null;
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <Providers withStore>
                <Probe />
                <DiffDialog onOpenMail={() => {}} />
            </Providers>
        );
    });
    act(() => {
        store.stage({
            id: 'c-1',
            kind: 'create-folder',
            folder: { name: 'Ablage' },
        });
    });
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    container.remove();
});

describe('what the dialog promises before anything is sent', () => {
    it('shows the change it is about', () => {
        expect(container.textContent).toContain('Ordner „Ablage" anlegen');
    });

    it('says nothing is written yet', () => {
        // Rendered against the demo mailbox, which is the only source this harness can produce.
        expect(container.textContent).toContain('es wird nichts geschrieben');
    });
});

describe('the sentence about the terminal', () => {
    // Read from the source, because the real-account branch needs a running server to render and
    // the claim being checked is about the wording, not the layout.
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'DiffDialog.tsx'), 'utf8');

    it('no longer promises a terminal question for every change', () => {
        expect(source).not.toContain('Die Rückfrage kommt im Terminal, nicht hier.');
        // And it names both second questions, because there are two and they are answered in
        // different places: a password here for a deletion, the terminal for anything that moves
        // mail. A sentence that mentioned only one would send somebody to the wrong window.
        expect(source).toContain('noch einmal nach deinem Passwort gefragt');
        expect(source).toContain('kommt eine Rückfrage im Terminal');
    });

    it('still promises the backup, which really is unconditional', () => {
        expect(source).toContain('vollständige Sicherung aller Filter und Ordner');
    });

    it('shows each waiting notice only where that question is actually asked', () => {
        /*
         * `place` rides in the 202 next to the check digits, and there are three answers rather
         * than two. Without the guard the terminal notice appeared for every change and was wrong
         * for most of them; with only a boolean it would now appear for a deletion, which asks
         * here instead — and somebody would sit watching a terminal that says nothing.
         */
        expect(source).toContain("phase.phase === 'waiting' && phase.place === 'terminal'");
        expect(source).toContain("phase.phase === 'waiting' && phase.place === 'password'");
        expect(source).toContain("phase.phase === 'waiting' && !phase.needsSecond");
    });

    it('sends the password to the account surface, never to the apply route', () => {
        // A `ChangeRequest` is digested, journalled and reported. Nothing carrying a password may
        // end up in a record somebody can read back.
        expect(source).toContain("action: 'confirm-change'");
        expect(source).not.toMatch(/fetch\('\/api\/apply'[\s\S]{0,400}password/);
    });
});
