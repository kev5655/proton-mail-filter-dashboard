import { useEffect, useId, useRef, useState } from 'react';

/**
 * The reasoning, one click away instead of three lines down.
 *
 * This project explains itself a lot, on purpose: a screen that says what a rule will do and not
 * why is a screen people learn to click through. But the explanation and the fact do not need the
 * same room — the fact has to be read, the reason has to be *available*. Paragraphs of justification
 * next to every number turned the interface into a document.
 *
 * So the rule is: the claim stays visible, the argument moves in here. Never the other way round.
 * Nothing that changes what somebody would decide belongs behind a click — a warning about what a
 * rule catches, what a deletion takes with it, or which mailbox is on screen stays where it is.
 *
 * Hover opens it, and so do focus and a tap. That combination is the whole design: hover alone does
 * not exist on a phone and cannot be reached from a keyboard, so the mark is a real button with
 * `aria-expanded` that a tap toggles, and CSS opens the same bubble on `:hover` and `:focus-within`
 * without anybody having to click. The content is text in the page rather than a `title`
 * attribute — `title` is invisible on touch and disappears while it is being read.
 */
export function Info({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const id = useId();
    const holder = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (event: MouseEvent): void => {
            if (holder.current !== null && !holder.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('keydown', escape);
        };
    }, [open]);

    return (
        <span className="info" ref={holder}>
            <button
                type="button"
                className="info-mark"
                aria-label={label}
                aria-expanded={open}
                aria-controls={id}
                onClick={() => {
                    setOpen(!open);
                }}
            >
                i
            </button>
            {/*
             * Always in the DOM, shown by CSS on hover and focus and by `is-open` on a tap.
             *
             * Mounting it only while `open` would make hover impossible without a click, which is
             * the thing this is not supposed to require.
             */}
            <span className={open ? 'info-bubble is-open' : 'info-bubble'} id={id} role="note">
                {children}
            </span>
        </span>
    );
}
