import { createHash } from 'node:crypto';

import type { ChangePlan, PendingChange } from '@pms/changes';

/**
 * What the dashboard offers, and what the terminal confirms.
 *
 * The same object crosses two boundaries — an HTTP request and a person's eyes — and it has to mean
 * the same thing on both sides. That is what the digest is for: the browser shows six characters
 * next to „warte auf Bestätigung", the terminal prints the same six above the question, and a
 * request swapped between the click and the keystroke shows different ones.
 *
 * It carries the plan the user was shown rather than recomputing one. Recomputing would be tidier
 * and would defeat the purpose: what has to be confirmed is the consequence that was *displayed*,
 * not a fresh calculation that might have moved.
 */

export interface ChangeRequest {
    requestId: string;
    createdAt: number;
    change: PendingChange;
    /** Exactly what the diff dialog showed. Not recomputed here. */
    plan: ChangePlan;
    /** The messages the plan says should move. The only ids the backlog step is ever given. */
    affectedMessageIds: string[];
    /** Whether existing mail is touched at all. "No" is a legitimate answer. */
    applyToExisting: boolean;
    /** Fingerprint of the filters and folders the plan was computed against. */
    baseVersion: string;
}

/**
 * A stable digest of what is being asked for.
 *
 * Over the change and its consequences, not over the identifiers: two requests describing the same
 * write have the same digest whenever they were made, and a request whose *effect* differs has a
 * different one. `requestId` and `createdAt` are excluded for that reason.
 */
export function digestOf(request: ChangeRequest): string {
    const material = canonical({
        change: request.change,
        moves: request.plan.moves.map((move) => `${move.messageId}:${move.from ?? ''}>${move.to ?? ''}`).sort(),
        applyToExisting: request.applyToExisting,
        baseVersion: request.baseVersion,
    });
    return createHash('sha256').update(material).digest('hex');
}

/** The part a person compares. Not a secret — a comparison aid, and short enough to actually read. */
export function shortDigest(digest: string): string {
    return `${digest.slice(0, 3)}-${digest.slice(3, 6)}`.toUpperCase();
}

/**
 * JSON with its keys in a fixed order.
 *
 * `JSON.stringify` follows insertion order, so two objects with the same fields can serialise
 * differently and hash differently — which would make the digest a coin toss rather than an
 * identity.
 */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : 1));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
