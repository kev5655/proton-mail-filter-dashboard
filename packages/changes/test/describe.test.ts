import { ConditionComparator, ConditionType, FilterStatement, type SimpleObject } from '@proton/sieve/filterModel';
import type { OrderedRule } from '@pms/rules';
import { describe, expect, it } from 'vitest';

import { describeChange } from '../src/describe.js';
import type { ChangeKind, PendingChange } from '../src/plan.js';

/**
 * Naming a change, once, for the three places that have to agree.
 *
 * The diff shows it, the terminal asks about it, and the history lists it afterwards — and somebody
 * reading the history is trying to recognise something they approved an hour ago. Ten hand-written
 * summaries produced two wordings for one act depending on which screen staged it, and „Regel „X"
 * ändern" for an edit that sent mail to a different folder.
 */

function rule(name: string, target: string): OrderedRule {
    const simple: SimpleObject = {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: 'Sender', value: ConditionType.SENDER },
                Comparator: { label: 'contains', value: ConditionComparator.CONTAINS },
                Values: ['shop.example'],
            },
        ],
        Actions: { FileInto: [target], Mark: { Read: false, Starred: false } },
    };
    return { id: 'r-1', name, priority: 1, enabled: true, rule: simple };
}

describe('naming a change', () => {
    it('says where a new rule files', () => {
        expect(
            describeChange({ id: 'c', kind: 'create-rule', after: rule('Shop', 'Werbung') })
        ).toBe('Regel „Shop" anlegen: nach „Werbung"');
    });

    it('names the destination an edit moved', () => {
        // „Regel „X" ändern" is the entry nobody can place a week later. The destination is the one
        // field whose change sends mail somewhere else, so it belongs in the line.
        expect(
            describeChange({
                id: 'c',
                kind: 'update-rule',
                before: rule('Shop', 'Werbung'),
                after: rule('Shop', 'Archiv'),
            })
        ).toBe('Regel „Shop" ändern: Ziel von „Werbung" auf „Archiv"');
    });

    it('stays plain when an edit changed something else', () => {
        // Everything else needs the diff to understand, and inventing a summary of it here would be
        // a worse kind of wrong than saying less.
        expect(
            describeChange({
                id: 'c',
                kind: 'update-rule',
                before: rule('Shop', 'Werbung'),
                after: rule('Shop neu', 'Werbung'),
            })
        ).toBe('Regel „Shop" ändern');
    });

    it('says what a folder change does, including where it goes', () => {
        expect(
            describeChange({ id: 'c', kind: 'create-folder', folder: { name: 'Rechnungen' } })
        ).toBe('Ordner „Rechnungen" anlegen');
        expect(
            describeChange({ id: 'c', kind: 'create-folder', folder: { name: 'Q1', parent: 'Rechnungen' } })
        ).toBe('Ordner „Q1" unter „Rechnungen" anlegen');
        expect(
            describeChange({ id: 'c', kind: 'rename-folder', folder: { name: 'Alt', newName: 'Neu' } })
        ).toBe('Ordner „Alt" in „Neu" umbenennen');
    });

    it('says which changes leave the account alone', () => {
        // Both of these read as destructive and are not, which is exactly the confusion a summary
        // is there to prevent.
        expect(describeChange({ id: 'c', kind: 'adopt-rule', before: rule('Shop', 'Werbung') })).toContain(
            'am Konto ändert sich nichts'
        );
        expect(describeChange({ id: 'c', kind: 'disable-rule', before: rule('Shop', 'Werbung') })).toContain(
            'bleibt bei Proton stehen'
        );
    });

    it('names the category by name, not by id', () => {
        expect(
            describeChange({
                id: 'c',
                kind: 'move-to-category',
                category: { id: '26', messageIds: ['m-1', 'm-2'] },
            })
        ).toBe('2 Mails nach „Transaktionen" verschieben');
    });

    it('has something to say about every kind there is', () => {
        // The exhaustive switch makes this a compile error rather than a test — this is the runtime
        // half: no kind may fall through to its own name, which is what an unhandled case produces.
        const kinds: ChangeKind[] = [
            'create-rule',
            'update-rule',
            'delete-rule',
            'enable-rule',
            'disable-rule',
            'create-folder',
            'rename-folder',
            'delete-folder',
            'adopt-rule',
            'move-to-category',
        ];

        for (const kind of kinds) {
            const change: PendingChange = { id: 'c', kind };
            expect(describeChange(change), kind).not.toBe(kind);
            expect(describeChange(change).length, kind).toBeGreaterThan(kind.length);
        }
    });
});
