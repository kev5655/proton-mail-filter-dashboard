import { useRef, useState } from 'react';

/**
 * A row you can push aside to remove.
 *
 * On a phone the folder list is mostly names, and two labelled buttons per row took more width
 * than the name did — so the one thing the screen is for became the one thing you could not read.
 * The buttons stay as icons; this is the gesture beside them.
 *
 * **It does not delete.** It stages, exactly as the button does, and the diff and the confirmation
 * follow as they always do. A gesture that removed a folder outright would be the one shortcut
 * around the rule this whole project is built on — and it would be the easiest thing in the app to
 * do by accident, on the surface where accidents are cheapest to make.
 *
 * Three details are deliberate:
 *
 *  - **Touch only.** A mouse has the buttons, and claiming horizontal drags on a pointer that also
 *    selects text takes away more than it gives.
 *  - **`touch-action: pan-y`** on the moving element, so the page still scrolls vertically while
 *    this owns the horizontal axis. Without it the browser and this code fight over the same drag.
 *  - **Either direction.** There is nothing on the other side to reveal, so insisting on one of
 *    them would only be a rule to learn.
 */

/** How far across the row the finger has to travel. Far enough not to happen while scrolling. */
const THRESHOLD = 0.4;

export function SwipeToDelete({
    label,
    onTrigger,
    children,
}: {
    /** What the exposed backing says, so the gesture names its own consequence mid-swipe. */
    label: string;
    onTrigger: () => void;
    children: React.ReactNode;
}): React.JSX.Element {
    const [offset, setOffset] = useState(0);
    const [sliding, setSliding] = useState(false);
    const start = useRef<{ x: number; y: number; width: number } | undefined>(undefined);

    const settle = (): void => {
        start.current = undefined;
        setSliding(false);
        setOffset(0);
    };

    return (
        <div className="folder-swipe">
            {/* Behind the row, revealed by it. `aria-hidden` because the icon button says this
                already, and to a screen reader the gesture does not exist. */}
            <div className="folder-swipe-action" aria-hidden="true">
                {label}
            </div>

            <div
                className={sliding ? 'folder-swipe-row is-sliding' : 'folder-swipe-row'}
                style={offset === 0 ? undefined : { transform: `translateX(${String(offset)}px)` }}
                onPointerDown={(event) => {
                    if (event.pointerType === 'mouse') {
                        return;
                    }
                    // A press that begins on a control is that control's, not the row's.
                    if ((event.target as HTMLElement).closest('button') !== null) {
                        return;
                    }
                    start.current = {
                        x: event.clientX,
                        y: event.clientY,
                        width: event.currentTarget.getBoundingClientRect().width,
                    };
                }}
                onPointerMove={(event) => {
                    const from = start.current;
                    if (from === undefined) {
                        return;
                    }
                    const dx = event.clientX - from.x;
                    // Vertical wins while it is ahead: the list has to stay scrollable, and a
                    // thumb travelling down a screen is never perfectly straight.
                    if (!sliding && Math.abs(event.clientY - from.y) > Math.abs(dx)) {
                        start.current = undefined;
                        return;
                    }
                    if (!sliding && Math.abs(dx) < 8) {
                        return;
                    }
                    setSliding(true);
                    setOffset(dx);
                }}
                onPointerUp={(event) => {
                    const from = start.current;
                    const travelled = from === undefined ? 0 : Math.abs(event.clientX - from.x);
                    const far = from !== undefined && travelled >= from.width * THRESHOLD;
                    settle();
                    if (far) {
                        onTrigger();
                    }
                }}
                onPointerCancel={settle}
                onPointerLeave={settle}
            >
                {children}
            </div>
        </div>
    );
}
