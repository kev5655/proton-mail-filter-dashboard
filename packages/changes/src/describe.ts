import { CATEGORY_LABELS } from '@pms/grouping';

import type { PendingChange } from './plan.js';

/**
 * One sentence saying what a change does, written once.
 *
 * It used to be built by hand at each call site — ten of them across the dashboard — which produced
 * two different wordings for the same kind depending on which screen staged it: „Regel „X" löschen"
 * on one and „Regel „X" bei Proton löschen" on another, for one identical request. The history then
 * inherited whichever phrasing happened to be used, and „Regel „X" ändern" said nothing at all about
 * what changed.
 *
 * The point is not tidiness. A change is described in three places that must agree — the diff, the
 * question in the terminal, and the history afterwards — and somebody reading the history is trying
 * to recognise something they approved an hour ago. Two wordings for one act make that harder than
 * it needs to be.
 *
 * Past tense is deliberately absent: the same sentence has to work before the change („Ordner „Alt"
 * in „Neu" umbenennen") and after it, in a list headed „Was geändert wurde". A neutral phrasing
 * reads correctly in both places; a tensed one is wrong in one of them.
 */
export function describeChange(change: PendingChange): string {
    const rule = change.after ?? change.before;
    const ruleName = rule?.name ?? '?';
    const folder = change.folder?.name ?? '?';

    switch (change.kind) {
        case 'create-rule':
            return `Regel „${ruleName}" anlegen${targetSuffix(change.after)}`;

        case 'update-rule':
            return `Regel „${change.before?.name ?? ruleName}" ändern${retargeting(change)}`;

        case 'delete-rule':
            return `Regel „${ruleName}" löschen`;

        case 'enable-rule':
            return `Regel „${ruleName}" wieder aktivieren`;

        case 'disable-rule':
            return `Regel „${ruleName}" deaktivieren — sie bleibt bei Proton stehen`;

        case 'adopt-rule':
            return `Regel „${ruleName}" übernehmen — am Konto ändert sich nichts`;

        case 'create-folder':
            return change.folder?.parent === undefined
                ? `Ordner „${folder}" anlegen`
                : `Ordner „${folder}" unter „${change.folder.parent}" anlegen`;

        case 'rename-folder':
            return `Ordner „${folder}" in „${change.folder?.newName ?? '?'}" umbenennen`;

        case 'delete-folder':
            return `Ordner „${folder}" löschen`;

        case 'move-to-category': {
            const count = change.category?.messageIds.length ?? 0;
            return `${String(count)} ${count === 1 ? 'Mail' : 'Mails'} nach „${categoryName(change.category?.id)}" verschieben`;
        }

        case 'undo-entry':
            // Named without its contents on purpose: what it will do lives in the journal entry,
            // and the diff reads it from there. A summary that guessed would be guessing about
            // somebody's mailbox.
            return 'Eine frühere Änderung zurücknehmen';

        default: {
            // Exhaustiveness: a new kind must be describable before it compiles. A change nobody
            // can name is a change nobody can recognise in the history.
            const unhandled: never = change.kind;
            return String(unhandled);
        }
    }
}

/** Where a rule files, when it files anywhere. */
function targetSuffix(rule: PendingChange['after']): string {
    const target = rule?.rule.Actions.FileInto.at(-1);
    return target === undefined || target === '' ? '' : `: nach „${target}"`;
}

/**
 * The part of an edit worth naming in one line.
 *
 * A rule can change in many ways and most of them need the diff to understand. The destination is
 * the exception: it is the single field whose change moves mail somewhere else, and „Regel „X"
 * ändern" with no further word is exactly the entry somebody cannot place a week later.
 */
function retargeting(change: PendingChange): string {
    const from = change.before?.rule.Actions.FileInto.at(-1);
    const to = change.after?.rule.Actions.FileInto.at(-1);
    if (from === undefined || to === undefined || from === to) {
        return '';
    }
    return `: Ziel von „${from}" auf „${to}"`;
}

/**
 * Proton's category names, from the one map that has them.
 *
 * Not copied here. Two lists in two packages that have to agree is exactly how `16` and `40` came
 * to be missing from one of them, and a snoozed message was reported to the user as an unknown
 * category. The dependency already exists for the category service.
 */
function categoryName(id: string | undefined): string {
    if (id === undefined) {
        return '?';
    }
    return CATEGORY_LABELS[id] ?? `Kategorie ${id}`;
}
