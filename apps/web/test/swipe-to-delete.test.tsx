// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SwipeToDelete } from '../src/components/SwipeToDelete.js';

/**
 * The gesture, and the one thing it must not become.
 *
 * A swipe that removed a folder outright would be the only shortcut in this app around
 * stage → diff → confirm, and it would be the easiest thing here to do by accident. So what is
 * asserted is not „it deletes" but „it calls the same thing the button calls" — and every case
 * below exists because it is a way for a scroll to be mistaken for a decision.
 */

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
});

function render(onTrigger: () => void): HTMLElement {
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(
            <SwipeToDelete label="Löschen" onTrigger={onTrigger}>
                <div className="folder-row">
                    <span className="folder-name">Rechnungen</span>
                    <button type="button">Löschen</button>
                </div>
            </SwipeToDelete>
        );
    });

    const row = container.querySelector<HTMLElement>('.folder-swipe-row');
    if (row === null) {
        throw new Error('no swipe row rendered');
    }
    // happy-dom lays nothing out, so the row would measure zero and every swipe would clear a
    // threshold of zero. Pinning the width is what makes the fraction mean something here.
    row.getBoundingClientRect = () => ({ width: 300, height: 44, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 44, toJSON: () => ({}) });
    return row;
}

interface Point {
    x?: number;
    y?: number;
    type?: string;
    target?: Element | undefined;
}

function pointer(row: HTMLElement, name: string, { x = 0, y = 0, type = 'touch', target }: Point = {}): void {
    act(() => {
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: x, clientY: y, pointerType: type });
        (target ?? row).dispatchEvent(event);
    });
}

function swipe(row: HTMLElement, to: number, options: Point = {}): void {
    pointer(row, 'pointerdown', { x: 0, y: 0, ...options });
    pointer(row, 'pointermove', { x: to, y: options.y ?? 0, ...options });
    pointer(row, 'pointerup', { x: to, y: options.y ?? 0, ...options });
}

describe('pushing a row aside', () => {
    it('stages rather than deletes — it calls exactly what the button calls', () => {
        const onTrigger = vi.fn();
        swipe(render(onTrigger), 200);

        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('works in either direction, because there is nothing on the other side to reveal', () => {
        const onTrigger = vi.fn();
        swipe(render(onTrigger), -200);

        expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it('ignores a short push, which is what a scroll that drifts looks like', () => {
        const onTrigger = vi.fn();
        swipe(render(onTrigger), 40);

        expect(onTrigger).not.toHaveBeenCalled();
    });

    it('lets a vertical drag be vertical', () => {
        // A thumb travelling down a list is never perfectly straight. Whichever axis is ahead wins.
        const onTrigger = vi.fn();
        const row = render(onTrigger);
        pointer(row, 'pointerdown', { x: 0, y: 0 });
        pointer(row, 'pointermove', { x: 60, y: 200 });
        pointer(row, 'pointerup', { x: 200, y: 260 });

        expect(onTrigger).not.toHaveBeenCalled();
    });

    it('leaves a mouse alone, which has the buttons anyway', () => {
        const onTrigger = vi.fn();
        swipe(render(onTrigger), 200, { type: 'mouse' });

        expect(onTrigger).not.toHaveBeenCalled();
    });

    it('does not start on a control, whose press belongs to the control', () => {
        const onTrigger = vi.fn();
        const row = render(onTrigger);
        const button = container.querySelector('button');

        swipe(row, 200, { target: button ?? undefined });

        expect(onTrigger).not.toHaveBeenCalled();
    });

    it('gives back the row when the gesture is cancelled mid-swipe', () => {
        const onTrigger = vi.fn();
        const row = render(onTrigger);
        pointer(row, 'pointerdown', { x: 0 });
        pointer(row, 'pointermove', { x: 150 });
        expect(row.style.transform).toBe('translateX(150px)');

        pointer(row, 'pointercancel', { x: 150 });

        expect(row.style.transform).toBe('');
        expect(onTrigger).not.toHaveBeenCalled();
    });
});
