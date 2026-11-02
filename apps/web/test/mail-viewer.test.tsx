// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MailViewer } from '../src/components/MailViewer.js';
import { Providers } from './harness.js';

/**
 * What the viewer shows, which is everything about a message and none of it.
 *
 * This pins the bug that made a security check pass for the wrong reason. `MailViewer` used to call
 * `bodyFor(subject)` from the demo package for every message; a real subject matched nothing and
 * fell through to a placeholder, so a real advertising mail looked empty and image-free. It was
 * reported as "no images in it" — and it was true, because there was no mail in it.
 *
 * With the demo gone there is no source of bodies at all: Proton encrypts them end to end and the
 * endpoint this dashboard reads carries none. So the viewer renders headers and says why, and the
 * assertions are that it says so rather than showing an empty frame that could be mistaken for an
 * empty message.
 */

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

/*
 * Unmounted, not merely detached.
 *
 * Removing the container leaves the React root alive with work still scheduled against it. That
 * work runs after Vitest has torn the DOM environment down, and „ReferenceError: window is not
 * defined" then surfaces as an unhandled error attributed to whichever file happened to be running
 * — which is why the failure moved around and only appeared in the full suite.
 */
afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
});

let root: Root | undefined;

function render(element: React.JSX.Element): void {
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(
<Providers>{element}</Providers>
        );
    });
}

const message = {
    ID: 'm1',
    Subject: 'Ein Betreff aus einem echten Postfach',
    Sender: { Address: 'wer@dort.example' },
    Time: 1_700_000_000,
};

describe('the viewer', () => {
    it('renders without a body without falling over', () => {
        render(<MailViewer message={message} onClose={() => {}} />);

        expect(container.textContent).toContain('Ein Betreff aus einem echten Postfach');
        expect(container.textContent).toContain('wer@dort.example');
    });

    it('says there is no text, and why, rather than showing an empty frame', () => {
        // An empty frame reads as an empty mail. The distinction matters because it is the
        // difference between „diese Mail ist leer" and „wir kommen an den Text nicht heran".
        render(<MailViewer message={message} onClose={() => {}} />);

        expect(container.textContent).toContain('Kein Inhalt vorhanden');
        expect(container.textContent).toContain('Ende zu Ende');
        expect(container.querySelector('iframe')).toBeNull();
    });

    it('offers the one place the text can actually be read', () => {
        render(<MailViewer message={message} onClose={() => {}} />);

        const link = container.querySelector<HTMLAnchorElement>('a[target="_blank"]');
        expect(link?.textContent).toContain('Bei Proton öffnen');
        expect(link?.getAttribute('rel')).toContain('noopener');
    });
});
