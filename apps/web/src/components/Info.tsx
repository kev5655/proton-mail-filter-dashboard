import { Hint } from './Hint.js';

/**
 * The reasoning, one hover away instead of three lines down.
 *
 * This project explains itself a lot, on purpose: a screen that says what a rule will do and not why
 * is a screen people learn to click through. But the explanation and the fact do not need the same
 * room — the fact has to be read, the reason has to be *available*. Paragraphs of justification next
 * to every number turned the interface into a document.
 *
 * So the rule is: the claim stays visible, the argument moves in here. Never the other way round.
 * Nothing that changes what somebody would decide belongs behind a hover — a warning about what a
 * rule catches, what a deletion takes with it, or which mailbox is on screen stays where it is.
 *
 * The mark is a real button so it can be reached from a keyboard and tapped on a phone, where hover
 * does not exist. `Hint` does the rest, including staying out of the scroll containers it sits in.
 */
export function Info({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <Hint text={children} className="info" toggleOnClick>
            <button type="button" className="info-mark" aria-label={label}>
                i
            </button>
        </Hint>
    );
}
