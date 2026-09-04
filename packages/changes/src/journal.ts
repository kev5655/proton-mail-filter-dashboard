import { applyChangeToRules, type PendingChange } from './plan.js';
import type { OrderedRule } from '@pms/rules';

/**
 * The record of what was done, and the means to undo it.
 *
 * Two things are kept per entry, and both are needed. The **inverse change** puts the rule set back;
 * the **snapshot of moved messages** puts the mail back. Neither alone is enough: deleting a rule
 * does not return the mail it already filed, and moving mail back without removing the rule means it
 * is filed again within the hour.
 *
 * The snapshot records where each message was *before*, one message at a time. That is what keeps
 * undo honest — it moves exactly the messages this change moved, never a category, never everything
 * currently in a folder. Someone who filed a mail there by hand after the fact does not lose it.
 */

export interface MovedMessage {
    messageId: string;
    /** Its label set before the change, so undo restores rather than guesses. */
    previousLabelIds: string[];
    /** Where the change put it, kept for the history entry's text. */
    movedTo: string | undefined;
}

export interface VerificationResult {
    /** Messages Proton really moved. */
    confirmed: number;
    /** Messages that should have moved and did not — reported, never swallowed. */
    stragglers: string[];
    checkedAt: number;
}

export interface JournalEntry {
    id: string;
    at: number;
    change: PendingChange;
    /** The change that undoes this one. */
    inverse: PendingChange;
    moved: MovedMessage[];
    verification?: VerificationResult | undefined;
    undoneAt?: number | undefined;
}

/**
 * Build the change that reverses this one.
 *
 * Derived rather than stored as a special case per kind, so a new change kind cannot be added
 * without deciding how it is undone — the compiler asks.
 */
export function inverseOf(change: PendingChange): PendingChange {
    const base = { id: `${change.id}-undo` };

    switch (change.kind) {
        case 'create-rule':
            return {
                ...base,
                kind: 'delete-rule',
                before: change.after,
            };

        case 'delete-rule':
            return {
                ...base,
                kind: 'create-rule',
                after: change.before,
            };

        case 'update-rule':
            return {
                ...base,
                kind: 'update-rule',
                before: change.after,
                after: change.before,
            };

        case 'enable-rule':
            return {
                ...base,
                kind: 'disable-rule',
                before: change.before,
            };

        case 'disable-rule':
            return {
                ...base,
                kind: 'enable-rule',
                before: change.before,
            };

        case 'create-folder':
            return {
                ...base,
                kind: 'delete-folder',
                folder: change.folder,
            };

        case 'delete-folder':
            return {
                ...base,
                kind: 'create-folder',
                folder: change.folder,
            };

        // Undoing an adoption is disowning the rule again — the rule itself is untouched either way.
        case 'adopt-rule':
            return {
                ...base,
                kind: 'adopt-rule',
                before: change.before,
            };

        /*
         * Undoing a category move is the one inverse that is not in this object.
         *
         * Every other kind reverses by description — a create becomes a delete, a rename becomes
         * the opposite rename — because the description is the whole change. Here it is not: the
         * change moved twenty messages that came from four different places, and there is no single
         * destination to name. That is what `entry.moved` is for. Each message carries its own
         * `previousLabelIds`, observed before the write, and `undoChange` puts each one back where
         * its own snapshot says it was.
         *
         * So the inverse deliberately carries no `category`. Naming one would be picking a
         * destination for messages that did not share one, and `apply.ts` refuses a category move
         * without ids rather than acting on it.
         */
        case 'move-to-category':
            return {
                ...base,
                kind: 'move-to-category',
            };

        case 'rename-folder':
            return {
                ...base,
                kind: 'rename-folder',
                folder: {
                    name: change.folder?.newName ?? '',
                    newName: change.folder?.name ?? '',
                    parent: change.folder?.parent,
                },
            };

        /*
         * Undoing an undo is not offered, and this is where that is decided.
         *
         * A redo would have to re-apply the original change — which is a different act from
         * reversing this one, needs its own diff, and would let two entries in the record disagree
         * about what the account looks like. The inverse therefore names no entry, `apply.ts`
         * refuses an undo without one, and the history offers no button. Rewinding *past* an undo
         * is likewise excluded, in the query that builds the chain.
         */
        case 'undo-entry':
        case 'rewind-to':
            return { ...base, kind: 'undo-entry' };

        default: {
            // Exhaustiveness: a new kind must decide how it is undone before it compiles.
            const exhaustive: never = change.kind;
            throw new Error(`Kein Undo definiert für ${String(exhaustive)}`);
        }
    }
}

export class Journal {
    #entries: JournalEntry[] = [];

    get entries(): readonly JournalEntry[] {
        // Newest first: the thing most likely to need undoing is the thing just done.
        return [...this.#entries].sort((a, b) => b.at - a.at);
    }

    record(entry: Omit<JournalEntry, 'inverse'>): JournalEntry {
        const complete: JournalEntry = { ...entry, inverse: inverseOf(entry.change) };
        this.#entries.push(complete);
        return complete;
    }

    /**
     * Undo one entry and report exactly which messages should be moved back.
     *
     * The caller performs the moves — this package computes, it does not reach for the network. The
     * separation is the reason the calculation can be tested at all.
     */
    undo(entryId: string, rules: OrderedRule[], now: number): { rules: OrderedRule[]; restore: MovedMessage[] } {
        const entry = this.#entries.find((candidate) => candidate.id === entryId);
        if (entry === undefined) {
            throw new Error(`Kein Eintrag mit der Kennung ${entryId}.`);
        }
        if (entry.undoneAt !== undefined) {
            throw new Error('Dieser Eintrag wurde bereits rückgängig gemacht.');
        }

        entry.undoneAt = now;
        return { rules: applyChangeToRules(rules, entry.inverse), restore: entry.moved };
    }

    attachVerification(entryId: string, verification: VerificationResult): void {
        const entry = this.#entries.find((candidate) => candidate.id === entryId);
        if (entry !== undefined) {
            entry.verification = verification;
        }
    }
}
