import { protonEscapingIsBroken } from '@pms/rules';
import type { MailboxFolder, MailboxRule } from '@pms/server/types';
import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type SimpleObject,
} from '@proton/sieve/filterModel';

import { COMPARATOR_NAMES, FIELD_NAMES } from './labels.js';

/**
 * A rule being edited, as opposed to a rule.
 *
 * Two things separate this from `SimpleObject` and both exist for the editor's sake. Each condition
 * carries a stable `uid`, so React keys and the preview's per-condition cache survive a value being
 * added in the middle of the list. And each carries `pending` — what has been typed into the value
 * box but not yet committed as a chip.
 *
 * `pending` is deliberately not part of the rule. Compiling on every keystroke would mean running a
 * condition across the whole mailbox for each character of a half-typed address, and showing a
 * preview for a rule the user has not finished writing. Values become part of the rule when they
 * become chips; until then the preview holds still.
 */

export interface DraftCondition {
    uid: string;
    type: ConditionType;
    comparator: ConditionComparator;
    /** OR-ed within one condition, which is what Proton's "oder" between chips means. */
    values: string[];
    /** Typed, not yet committed. Never compiled, never previewed. */
    pending: string;
}

export interface RuleDraft {
    /** Undefined for a rule that does not exist yet. */
    ruleId: string | undefined;
    name: string;
    operator: FilterStatement;
    conditions: DraftCondition[];
    /** Empty means the rule only marks; Proton allows that and so do we. */
    folder: string;
    /**
     * Whether the target above is a folder or a label.
     *
     * It compiles to the same thing — Proton's filter model has no label action, the name goes into
     * `FileInto` either way and Proton resolves it against whichever object carries it. What this
     * decides is two other things: what the preview predicts (a folder moves the mail out of the
     * inbox, a label marks it and leaves it), and what gets *created* when the name is new. Without
     * it, somebody typing a new label name silently got a folder.
     */
    targetKind: 'folder' | 'label';
    markRead: boolean;
    markStarred: boolean;
    enabled: boolean;
}

let counter = 0;
function nextUid(): string {
    counter++;
    return `c${String(counter)}`;
}

export function emptyCondition(type: ConditionType = ConditionType.SENDER): DraftCondition {
    return { uid: nextUid(), type, comparator: ConditionComparator.CONTAINS, values: [], pending: '' };
}

export function newDraft(folder = ''): RuleDraft {
    return {
        ruleId: undefined,
        name: '',
        operator: FilterStatement.ALL,
        conditions: [emptyCondition()],
        folder,
        // Moving is the ordinary case and the one somebody arriving at an empty rule means.
        targetKind: 'folder',
        markRead: false,
        markStarred: false,
        enabled: true,
    };
}

export function fromRule(rule: MailboxRule): RuleDraft {
    return {
        ruleId: rule.id,
        name: rule.name,
        operator: rule.rule.Operator.value,
        conditions: rule.rule.Conditions.map((condition) => ({
            uid: nextUid(),
            type: condition.Type.value,
            comparator: condition.Comparator.value,
            values: [...condition.Values],
            pending: '',
        })),
        folder: rule.rule.Actions.FileInto.at(-1) ?? '',
        // Read back from the account rather than stored on the rule, because Proton does not store
        // it on the rule either.
        targetKind: 'folder',
        markRead: rule.rule.Actions.Mark.Read,
        markStarred: rule.rule.Actions.Mark.Starred,
        enabled: rule.enabled,
    };
}

/**
 * The rule a draft describes.
 *
 * `label` is display text and is never matched on — `matchesRule` reads only `.value` — but it is
 * written from the shared label map anyway, so a rule built here is shaped exactly like one built
 * by `ruleFromGroup` and the two cannot be told apart downstream.
 *
 * A condition with no values is dropped rather than compiled: Proton would store a test against an
 * empty key list, which matches nothing and looks like a rule that simply does not work.
 */
export function toSimpleObject(draft: RuleDraft): SimpleObject {
    return {
        Operator: {
            label: draft.operator === FilterStatement.ANY ? 'any' : 'all',
            value: draft.operator,
        },
        Conditions: draft.conditions
            .filter((condition) => condition.type === ConditionType.ATTACHMENTS || condition.values.length > 0)
            .map((condition) => ({
                Type: { label: FIELD_NAMES[condition.type] ?? condition.type, value: condition.type },
                Comparator: {
                    label: COMPARATOR_NAMES[condition.comparator] ?? condition.comparator,
                    value: condition.comparator,
                },
                // Attachments ignore their values at Proton, so carrying any would be noise.
                Values: condition.type === ConditionType.ATTACHMENTS ? [] : [...condition.values],
            })),
        Actions: {
            FileInto: draft.folder === '' ? [] : [draft.folder],
            Mark: { Read: draft.markRead, Starred: draft.markStarred },
        },
    };
}

/** Whether anything that reaches Proton has changed. `uid` and `pending` do not. */
export function isDirty(original: RuleDraft, draft: RuleDraft): boolean {
    return signature(original) !== signature(draft);
}

function signature(draft: RuleDraft): string {
    return JSON.stringify({
        name: draft.name,
        folder: draft.folder,
        // Part of the signature because it changes what a save *creates* when the name is new —
        // a folder or a label — even though it compiles to the same rule either way.
        targetKind: draft.targetKind,
        enabled: draft.enabled,
        markRead: draft.markRead,
        markStarred: draft.markStarred,
        rule: toSimpleObject(draft),
    });
}

export type ProblemLevel = 'error' | 'warning';

export interface DraftProblem {
    level: ProblemLevel;
    message: string;
    /** The condition it belongs to, so it can be shown where the mistake is. */
    uid?: string | undefined;
}

/**
 * What is wrong with a draft, in the order it should be read.
 *
 * `error` means Proton would reject it or store something that cannot work; the editor refuses to
 * stage it. `warning` means it will be stored and do something surprising — those are shown and
 * then it is the user's decision, because a rule that catches everything is occasionally what
 * someone actually wants.
 */
export function validateDraft(
    draft: RuleDraft,
    folders: readonly MailboxFolder[],
    labels: readonly MailboxFolder[] = []
): DraftProblem[] {
    const problems: DraftProblem[] = [];

    if (draft.name.trim() === '') {
        problems.push({ level: 'error', message: 'Die Regel braucht einen Namen.' });
    }

    for (const condition of draft.conditions) {
        if (condition.type !== ConditionType.ATTACHMENTS && condition.values.length === 0) {
            problems.push({
                level: 'error',
                message: `„${FIELD_NAMES[condition.type] ?? condition.type}" hat keinen Wert. Text eingeben und mit Enter bestätigen.`,
                uid: condition.uid,
            });
        }
    }

    const compiled = toSimpleObject(draft);

    if (compiled.Conditions.length === 0) {
        problems.push({
            level: 'warning',
            message: 'Ohne Bedingung trifft diese Regel jede Mail.',
        });
    }

    if (draft.folder === '') {
        problems.push({
            level: 'warning',
            message: 'Ohne Ziel verschiebt und markiert die Regel nichts.',
        });
    } else {
        const known = draft.targetKind === 'label' ? labels : folders;
        const exists = known.some(
            (entry) => entry.Name === draft.folder || entry.Name.endsWith(`/${draft.folder}`)
        );
        // The opposite kind having the name is worth its own sentence: Proton allows a folder and a
        // label to be called the same thing, and then the rule's behaviour depends on which one it
        // resolves against — which is not something to discover after the mail has moved.
        const other = (draft.targetKind === 'label' ? folders : labels).some(
            (entry) => entry.Name === draft.folder
        );

        if (!exists) {
            problems.push({
                level: 'warning',
                message:
                    draft.targetKind === 'label'
                        ? `Das Label „${draft.folder}" gibt es noch nicht. Es wird zusammen mit der Regel angelegt.`
                        : `Den Ordner „${draft.folder}" gibt es noch nicht. Er wird zusammen mit der Regel angelegt.`,
            });
        }
        if (other) {
            problems.push({
                level: 'warning',
                message:
                    draft.targetKind === 'label'
                        ? `Es gibt auch einen Ordner „${draft.folder}". Proton erlaubt beides, und welches die Regel trifft, entscheidet Proton — nicht wir.`
                        : `Es gibt auch ein Label „${draft.folder}". Proton erlaubt beides, und welches die Regel trifft, entscheidet Proton — nicht wir.`,
            });
        }
    }

    // Proton's own escaping defect, surfaced before the rule is written rather than after mail has
    // gone missing. See `protonEscapingIsBroken`: `a*b` compiles to something matching almost
    // nothing, and Proton's own interface does not warn about it either.
    const compiledConditions = compiled.Conditions;
    for (const warning of protonEscapingIsBroken(compiled)) {
        const source = draftConditionFor(draft, compiledConditions, warning.conditionIndex);
        problems.push({
            level: 'warning',
            message: `„${warning.value}": ${warning.reason}`,
            ...(source === undefined ? {} : { uid: source.uid }),
        });
    }

    return problems;
}

/**
 * Map a compiled condition index back to the draft condition it came from.
 *
 * `toSimpleObject` drops valueless conditions, so the indexes do not line up on their own — and a
 * warning attached to the wrong row points at an innocent value.
 */
function draftConditionFor(
    draft: RuleDraft,
    compiled: SimpleObject['Conditions'],
    index: number
): DraftCondition | undefined {
    const kept = draft.conditions.filter(
        (condition) => condition.type === ConditionType.ATTACHMENTS || condition.values.length > 0
    );
    return index >= 0 && index < compiled.length ? kept[index] : undefined;
}

export type TreeVerdict = { expressible: true } | { expressible: false; reason: string };

/**
 * Whether a rule can be represented as a Proton tree filter — the clickable kind.
 *
 * A Sieve-authored filter can do things the tree form cannot, and Proton's own interface refuses to
 * edit one for exactly that reason. Converting is therefore an explicit choice, and it has to be
 * refused precisely rather than approximately: "this cannot be edited" is useless, "this redirects
 * to an address, which the editor has no field for" tells the user what they would lose.
 */
export function isExpressibleAsTree(rule: SimpleObject): TreeVerdict {
    const allowedTypes = new Set<string>([
        ConditionType.SENDER,
        ConditionType.SUBJECT,
        ConditionType.RECIPIENT,
        ConditionType.ATTACHMENTS,
    ]);
    const allowedComparators = new Set<string>(Object.values(ConditionComparator));

    for (const condition of rule.Conditions) {
        if (!allowedTypes.has(condition.Type.value)) {
            return { expressible: false, reason: `Die Bedingung „${condition.Type.value}" hat im Editor kein Feld.` };
        }
        if (!allowedComparators.has(condition.Comparator.value)) {
            return {
                expressible: false,
                reason: `Der Vergleich „${condition.Comparator.value}" ist im Editor nicht auswählbar.`,
            };
        }
    }

    if (rule.Actions.FileInto.length > 1) {
        return {
            expressible: false,
            reason: 'Die Regel sortiert in mehrere Ordner; der Editor kennt nur einen Zielordner.',
        };
    }
    if (rule.Actions.Vacation !== undefined && rule.Actions.Vacation !== null) {
        return { expressible: false, reason: 'Die Regel verschickt eine Abwesenheitsnotiz.' };
    }
    if (rule.Actions.Redirects !== undefined && rule.Actions.Redirects.length > 0) {
        return { expressible: false, reason: 'Die Regel leitet an eine Adresse weiter.' };
    }

    return { expressible: true };
}
