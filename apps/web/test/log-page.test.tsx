// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../src/components/ErrorBoundary.js';
import { log } from '../src/log.js';
import { ActivityLog } from '../src/components/ActivityLog.js';

/**
 * „Protokoll", rendered the way a browser renders it.
 *
 * The rest of the suite uses `renderToStaticMarkup`, which calls a store's `getServerSnapshot`
 * exactly once and then stops. That is why nobody saw this page take the whole application down:
 * the failure needs a *client* render, where `useSyncExternalStore` compares one snapshot with the
 * next and re-renders until two of them are the same object.
 *
 * So this file mounts for real. If `snapshot()` ever goes back to returning a fresh array, React
 * loops and throws here instead of in someone's browser.
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
    vi.restoreAllMocks();
});

let root: Root | undefined;

function mount(element: React.JSX.Element): void {
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(element);
    });
}

describe('the log page', () => {
    it('renders without looping, on an empty log', () => {
        mount(<ActivityLog />);

        expect(container.textContent).toContain('Was in diesem Tab passiert ist, in Sätzen');
    });

    it('renders the entries and survives new ones arriving', () => {
        // An event with no sentence of its own falls back to its key, which is how a missing
        // sentence stays visible instead of becoming an empty row.
        log('warn', 'sync.truncated', { count: 2000 });
        mount(<ActivityLog />);

        expect(container.textContent).toContain('sync.truncated');

        act(() => {
            log('error', 'rule.stage.failed', { code: 'RULE_COMPILE_FAILED' });
        });

        expect(container.textContent).toContain('rule.stage.failed');
    });

    it('does not warn that the snapshot should be cached', () => {
        // React's own diagnosis of the bug. It arrives as a console error just before the throw,
        // so catching it here means catching the loop before it becomes a blank screen.
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        mount(<ActivityLog />);

        const said = errors.mock.calls.map((call) => String(call[0] ?? '')).join(' ');
        expect(said).not.toContain('getSnapshot should be cached');
    });
});

describe('the error boundary', () => {
    function Exploding(): React.JSX.Element {
        throw new Error('kaputt');
    }

    it('keeps a crashing screen from taking the rest with it', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        mount(
            <div>
                <nav>Navigation</nav>
                <ErrorBoundary area="Regeln">
                    <Exploding />
                </ErrorBoundary>
            </div>
        );

        // The whole point: something is still on screen, and it is not a white page.
        expect(container.textContent).toContain('Navigation');
        expect(container.textContent).toContain('Hier ist etwas abgestürzt');
        expect(container.textContent).toContain('Regeln');
    });

    it('says that nothing was written to the account', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        mount(
            <ErrorBoundary area="Regeln">
                <Exploding />
            </ErrorBoundary>
        );

        expect(container.textContent).toContain('nichts geändert');
    });

    it('logs the error name but never its message', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        mount(
            <ErrorBoundary area="Regeln">
                <Exploding />
            </ErrorBoundary>
        );

        // A message can quote a subject line, and the log is meant to be handed over unedited.
        const report = container.textContent ?? '';
        expect(report).not.toContain('kaputt');
    });
});

describe('what a row says', () => {
    it('describes the event instead of printing its key and flags', () => {
        // The complaint this answers: the screen said `apply.applied` and `partial=false`, which
        // is the record a bug report needs and not an answer to „wurde meine Regel gespeichert?".
        log('info', 'apply.applied', { partial: false });
        mount(<ActivityLog />);

        expect(container.textContent).toContain('Änderung bei Proton gespeichert.');
        expect(container.textContent).not.toContain('partial=false');
        expect(container.textContent).not.toContain('apply.applied');
    });

    it('keeps the keys one click away, because a report needs them', () => {
        log('info', 'apply.applied', { partial: false });
        mount(<ActivityLog />);

        act(() => {
            [...container.querySelectorAll('button')]
                .find((button) => (button.textContent ?? '').includes('Technische Details'))
                ?.click();
        });

        expect(container.textContent).toContain('apply.applied');
        expect(container.textContent).toContain('partial=false');
    });
});
