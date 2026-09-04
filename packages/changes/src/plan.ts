import type { SimpleObject } from '@proton/sieve/filterModel';
import { resolveOutcome, type MatchableMessage, type OrderedRule } from '@pms/rules';

/**
 * Working out what a change would actually do, before it is made.
 *
 * The dashboard's promise is that nothing reaches Proton unexamined, and this is what makes that
 * promise mean something. A rule shown as "sender contains X → Archiv" tells the user what the rule
 * says; only simulating the whole rule set against the indexed mail tells them what it *does*.
 *
 * The two are different more often than one would like. Adding a rule can move mail that another
 * rule was quietly handling; deleting one can hand its mail to a catch-all further down. Both are
 * invisible from the rule text and obvious from the diff.
 */

export type ChangeKind =
    | 'create-rule'
    | 'update-rule'
    | 'delete-rule'
    | 'enable-rule'
    | 'disable-rule'
    | 'create-folder'
    | 'rename-folder'
    | 'delete-folder'
    /**
     * Taking responsibility for a rule that appeared at Proton on its own.
     *
     * The only kind that writes nothing to the account. It travels the same route as every other
     * change — offered, planned, recorded — because the decision it records is a real one: from
     * here on the tool treats that rule as part of the set it manages, and the diff shows what the
     * rule already does before anyone agrees to that.
     */
    | 'adopt-rule';

export interface PendingChange {
    id: string;
    kind: ChangeKind;
    /** One line, for the confirmation dialog and the history. */
    summary: string;
    /** For rule changes: the rule as it is now, absent when creating. */
    before?: OrderedRule | undefined;
    /** For rule changes: the rule as it would be, absent when deleting. */
    after?: OrderedRule | undefined;
    /** For folder changes. */
    folder?: { name: string; newName?: string; parent?: string | undefined } | undefined;
}

/** One message whose destination the change alters. */
export interface Move {
    messageId: string;
    subject: string;
    sender: string;
    /** Where it goes today. `undefined` means it stays in the inbox. */
    from: string | undefined;
    /** Where it would go afterwards. */
    to: string | undefined;
}

export interface ChangePlan {
    change: PendingChange;
    /** Every message whose destination differs before and after. */
    moves: Move[];
    /** Messages that would leave the inbox — the point of the exercise. */
    clearedFromInbox: number;
    /** Messages that would come *back* to the inbox, which is usually a surprise. */
    returnedToInbox: number;
    /**
     * Messages a different rule was handling and this change takes over, with that rule's name.
     * Not an error, but the thing most likely to be unintended.
     */
    takenFrom: Array<{ ruleName: string; count: number }>;
}

export interface PlanInput {
    rules: OrderedRule[];
    messages: Array<MatchableMessage & { ID: string; Subject: string; Sender: { Address: string } }>;
    change: PendingChange;
}

/**
 * Apply a pending change to a rule set without touching the original.
 *
 * Exported because the diff, the verification and the undo journal all need the same "what would
 * the world look like" calculation, and three implementations of it would drift.
 */
export function applyChangeToRules(rules: OrderedRule[], change: PendingChange): OrderedRule[] {
    switch (change.kind) {
        case 'create-rule':
            return change.after === undefined ? rules : [...rules, change.after];

        case 'update-rule':
            return change.after === undefined
                ? rules
                : rules.map((rule) => (rule.id === change.after?.id ? change.after : rule));

        case 'delete-rule':
            return rules.filter((rule) => rule.id !== change.before?.id);

        case 'enable-rule':
        case 'disable-rule':
            return rules.map((rule) =>
                rule.id === change.before?.id ? { ...rule, enabled: change.kind === 'enable-rule' } : rule
            );

        // Adopting changes who is responsible for a rule, not what it does.
        case 'adopt-rule':
            return rules;

        // Folder changes do not alter which rule matches what, only where the mail is put. A rename
        // is the exception, and it is handled by rewriting the rules that point at the old name.
        case 'rename-folder':
            return change.folder === undefined || change.folder.newName === undefined
                ? rules
                : rules.map((rule) => renameTarget(rule, change.folder?.name ?? '', change.folder?.newName ?? ''));

        default:
            return rules;
    }
}

function renameTarget(rule: OrderedRule, from: string, to: string): OrderedRule {
    const rewrite = (target: string): string =>
        target === from ? to : target.endsWith(`/${from}`) ? `${target.slice(0, -from.length)}${to}` : target;

    const fileInto = rule.rule.Actions.FileInto.map(rewrite);
    if (fileInto.every((target, index) => target === rule.rule.Actions.FileInto[index])) {
        return rule;
    }

    const updated: SimpleObject = {
        ...rule.rule,
        Actions: { ...rule.rule.Actions, FileInto: fileInto },
    };
    return { ...rule, rule: updated };
}

export function planChange({ rules, messages, change }: PlanInput): ChangePlan {
    const after = applyChangeToRules(rules, change);

    const moves: Move[] = [];
    const takenFrom = new Map<string, number>();

    for (const message of messages) {
        const before = resolveOutcome(rules, message);
        const now = resolveOutcome(after, message);

        if (before.destination === now.destination) {
            continue;
        }

        moves.push({
            messageId: message.ID,
            subject: message.Subject,
            sender: message.Sender.Address,
            from: before.destination,
            to: now.destination,
        });

        // Which rule used to decide this message, if any. Knowing that a new rule is taking mail
        // away from an existing one is the difference between a tidy-up and a surprise.
        const previousOwner = before.matching.filter((entry) => filesInto(entry)).at(-1);
        if (previousOwner !== undefined && previousOwner.id !== change.after?.id) {
            takenFrom.set(previousOwner.name, (takenFrom.get(previousOwner.name) ?? 0) + 1);
        }
    }

    return {
        change,
        moves,
        clearedFromInbox: moves.filter((move) => move.from === undefined && move.to !== undefined).length,
        returnedToInbox: moves.filter((move) => move.from !== undefined && move.to === undefined).length,
        takenFrom: [...takenFrom].map(([ruleName, count]) => ({ ruleName, count })).sort((a, b) => b.count - a.count),
    };
}

function filesInto(rule: OrderedRule): boolean {
    const target = rule.rule.Actions.FileInto.at(-1);
    return target !== undefined && target !== '';
}

/** A short, honest sentence about the consequences, for the confirmation button's neighbourhood. */
export function describePlan(plan: ChangePlan): string {
    if (plan.moves.length === 0) {
        return 'Diese Änderung verschiebt keine der erfassten Mails.';
    }

    const parts = [`${plan.moves.length} Mails würden anders einsortiert`];
    if (plan.clearedFromInbox > 0) {
        parts.push(`${plan.clearedFromInbox} verlassen den Posteingang`);
    }
    if (plan.returnedToInbox > 0) {
        parts.push(`${plan.returnedToInbox} kommen in den Posteingang zurück`);
    }
    return `${parts.join(', ')}.`;
}
