import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A bubble that explains the thing it is attached to, without moving anything.
 *
 * It exists because the earlier one *did* move things. The bubble was positioned absolutely inside
 * its trigger, and the sidebar is a scroll container: a bubble reaching past its edge grew the
 * sidebar's scrollable area, so hovering the sign-out button made the navigation scrollable
 * sideways and down. A tooltip that changes the page under the pointer is worse than no tooltip.
 *
 * So it renders into `document.body` at `position: fixed`, measured from the trigger. Fixed
 * elements are outside every scroll container by definition, which is the whole point — there is no
 * ancestor left whose overflow it could add to.
 *
 * Hover, focus and — where the trigger is not itself a control — a tap all open it. The trigger
 * stays whatever it was: `Hint` wraps it and never replaces it, so wrapping a button leaves a
 * button that still does its job on click.
 */
export function Hint({
    text,
    children,
    className = 'hint',
    toggleOnClick = false,
}: {
    text: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    /** For a trigger that has no other job — the `i` mark — so a tap can open it on a phone. */
    toggleOnClick?: boolean;
}): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState<{ top: number; left: number } | undefined>(undefined);
    const anchor = useRef<HTMLSpanElement>(null);
    const bubble = useRef<HTMLSpanElement>(null);
    const id = useId();

    /*
     * Measured after paint, in the same frame the bubble first appears.
     *
     * `useLayoutEffect` rather than `useEffect`: the bubble is rendered once at an off-screen
     * position so it can be measured, and a repaint between the two would show it in the corner.
     */
    useLayoutEffect(() => {
        if (!open) {
            setAt(undefined);
            return;
        }
        const settle = (): void => {
            const trigger = anchor.current?.getBoundingClientRect();
            const box = bubble.current?.getBoundingClientRect();
            if (trigger === undefined || box === undefined) {
                return;
            }
            setAt(place(trigger, box.width, box.height));
        };
        settle();
        // `true`: a scroll in any ancestor moves the trigger, and the bubble has to follow or
        // detach itself from what it explains.
        window.addEventListener('scroll', settle, true);
        window.addEventListener('resize', settle);
        return () => {
            window.removeEventListener('scroll', settle, true);
            window.removeEventListener('resize', settle);
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('keydown', escape);
        };
    }, [open]);

    return (
        <span
            className={className}
            ref={anchor}
            aria-describedby={open ? id : undefined}
            onMouseEnter={() => {
                setOpen(true);
            }}
            onMouseLeave={() => {
                setOpen(false);
            }}
            onFocus={() => {
                setOpen(true);
            }}
            onBlur={() => {
                setOpen(false);
            }}
            onClick={
                toggleOnClick
                    ? () => {
                          setOpen((was) => !was);
                      }
                    : undefined
            }
        >
            {children}
            {open &&
                createPortal(
                    <span
                        className="info-bubble"
                        id={id}
                        role="note"
                        ref={bubble}
                        style={
                            at === undefined
                                ? // Rendered but not yet placed: laid out at its natural width so
                                  // it can be measured, and kept out of sight until it is.
                                  { top: 0, left: 0, visibility: 'hidden' }
                                : { top: at.top, left: at.left }
                        }
                    >
                        {text}
                    </span>,
                    document.body,
                )}
        </span>
    );
}

/** Below the trigger, above it when there is no room, and never off the side. */
function place(trigger: DOMRect, width: number, height: number): { top: number; left: number } {
    const margin = 8;
    const gap = 6;

    let left = trigger.left;
    if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - margin - width;
    }
    left = Math.max(margin, left);

    let top = trigger.bottom + gap;
    if (top + height > window.innerHeight - margin) {
        const above = trigger.top - gap - height;
        top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height);
    }

    return { top, left };
}
