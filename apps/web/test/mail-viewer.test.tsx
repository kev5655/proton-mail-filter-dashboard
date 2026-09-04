// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MailViewer } from '../src/components/MailViewer.js';
import { Providers } from './harness.js';

/**
 * What the viewer shows when there is nothing to show.
 *
 * This pins the bug that made a security check pass for the wrong reason. `MailViewer` used to call
 * `bodyFor(subject)` from the demo package for every message; a real subject matched nothing and
 * fell through to a placeholder, so a real advertising mail looked empty and image-free. It was
 * reported as "no images in it" — and it was true, because there was no mail in it.
 *
 * Under test the mailbox provider cannot reach a server, so it reports the demo source. That is the
 * case where a body legitimately exists. The assertions below are therefore about the *demo* path
 * being labelled as such, plus the placeholder text never appearing as though it were content.
 */

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    container.remove();
});

function render(element: React.JSX.Element): void {
    const root = createRoot(container);
    act(() => {
        root.render(
<Providers>{element}</Providers>
        );
    });
}

const message = {
    ID: 'm1',
    Subject: 'Ein Betreff, den die Demo nicht kennt',
    Sender: { Address: 'wer@dort.example' },
    Time: 1_700_000_000,
};

describe('the viewer', () => {
    it('renders without a body without falling over', () => {
        render(<MailViewer message={message} onClose={() => {}} />);

        expect(container.textContent).toContain('Ein Betreff, den die Demo nicht kennt');
        expect(container.textContent).toContain('wer@dort.example');
    });

    it('never presents the demo placeholder as if it were the message', () => {
        // The exact string that made a real Samsung advert look like an empty mail.
        render(<MailViewer message={message} onClose={() => {}} />);

        const frame = container.querySelector<HTMLIFrameElement>('iframe');
        const shown = `${container.textContent ?? ''} ${frame?.getAttribute('srcdoc') ?? ''}`;
        expect(shown).not.toContain('Diese Demo-Mail hat keinen eigenen Inhalt');
    });

    it('keeps the sandbox and the no-referrer policy on whatever frame it does render', () => {
        render(<MailViewer message={message} onClose={() => {}} />);

        const frame = container.querySelector<HTMLIFrameElement>('iframe');
        if (frame !== null) {
            // Three layers, each written assuming the other two failed. This is the outermost.
            expect(frame.getAttribute('sandbox')).toBe('');
            expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
        }
    });
});
