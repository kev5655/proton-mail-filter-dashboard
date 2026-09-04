// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useStore } from '../src/store.js';
import { Providers } from './harness.js';

/**
 * When a decision about a drifted rule becomes true.
 *
 * „Änderungen" exists to report what really changed at Proton, so the one thing it must never do is
 * record a decision nobody made. It used to cross the entry off on the click — before the diff,
 * before the terminal question — so declining in the terminal left the rule marked as handled and
 * the list empty.
 *
 * Driven through the store rather than through the screen on purpose. The demo's drift entries name
 * ids no demo rule has, so both write-answers are disabled there and a click would prove nothing;
 * what is worth pinning is the rule about *when* a resolution is recorded, not which button is lit.
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

const change = {
    id: 'disable-d-1',
    kind: 'disable-rule' as const,
    summary: 'Regel „Zahnarzt" bei Proton deaktivieren',
};

describe('answering a rule that appeared at Proton', () => {
    it('does not resolve the entry merely because it was staged', () => {
        const before = store.drift.filter((item) => item.resolved === undefined).length;
        expect(before).toBeGreaterThan(0);

        act(() => {
            store.stage(change, { id: 'd-1', decision: 'reject' });
        });

        expect(store.staged).toBeDefined();
        expect(store.drift.find((item) => item.id === 'd-1')?.resolved).toBeUndefined();
    });

    it('resolves it once the change has landed', () => {
        act(() => {
            store.stage(change, { id: 'd-1', decision: 'reject' });
        });
        act(() => {
            store.settle();
        });

        expect(store.drift.find((item) => item.id === 'd-1')?.resolved).toBe('reject');
    });

    it('forgets the decision when the change is discarded', () => {
        // Declined in the terminal, or abandoned in the dialog. Either way nothing reached the
        // account, so the entry has to come back and be asked about again.
        act(() => {
            store.stage(change, { id: 'd-1', decision: 'reject' });
        });
        act(() => {
            store.discard();
        });
        act(() => {
            store.settle();
        });

        expect(store.drift.find((item) => item.id === 'd-1')?.resolved).toBeUndefined();
    });
});
