import { ConditionComparator, ConditionType, FilterStatement, type SimpleObject } from '@proton/sieve/filterModel';
import type { MatchableMessage, OrderedRule } from '@pms/rules';
import { describe, expect, it } from 'vitest';

import { Journal, inverseOf } from '../src/journal.js';
import {
    applyChangeToRules,
    describePlan,
    planCategoryMove,
    planChange,
    type PendingChange,
} from '../src/plan.js';
import { findRulesNotFiring, partialMoveError, verifyMoves } from '../src/verify.js';

/**
 * The machinery that stands between a decision and someone's mailbox.
 *
 * Three properties are worth more than the rest and are tested hardest: the diff must show
 * consequences the rule text does not reveal, undo must move back exactly the messages the change
 * moved and nothing else, and a partial result must be raised rather than rounded up to success.
 */

function rule(id: string, name: string, priority: number, value: string, folder: string): OrderedRule {
    const simple: SimpleObject = {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: 'Sender', value: ConditionType.SENDER },
                Comparator: { label: 'contains', value: ConditionComparator.CONTAINS },
                Values: [value],
            },
        ],
        Actions: { FileInto: [folder], Mark: { Read: false, Starred: false } },
    };
    return { id, name, priority, enabled: true, rule: simple };
}

function mail(id: string, sender: string): MatchableMessage & { ID: string; Subject: string } {
    return { ID: id, Subject: `Betreff ${id}`, Sender: { Address: sender }, ToList: [] };
}

const messages = [
    mail('m1', 'news@shop.example'),
    mail('m2', 'news@shop.example'),
    mail('m3', 'billing@bahn.example'),
    mail('m4', 'anna@freunde.example'),
];

describe('planning a change', () => {
    it('reports the mail a new rule would move out of the inbox', () => {
        const change: PendingChange = {
            id: 'c1',
            kind: 'create-rule',
            summary: 'Newsletter',
            after: rule('r-new', 'Newsletter', 1, 'news@shop.example', 'Newsletter'),
        };

        const plan = planChange({ rules: [], messages, change });

        expect(plan.moves).toHaveLength(2);
        expect(plan.clearedFromInbox).toBe(2);
        expect(plan.moves.every((move) => move.from === undefined && move.to === 'Newsletter')).toBe(true);
    });

    it('names the rule whose mail a new one takes over', () => {
        // Invisible in the rule text and the single most likely unintended consequence.
        const existing = rule('r-old', 'Alles ins Archiv', 1, '@', 'Archiv');
        const change: PendingChange = {
            id: 'c2',
            kind: 'create-rule',
            summary: 'Newsletter',
            after: rule('r-new', 'Newsletter', 2, 'news@shop.example', 'Newsletter'),
        };

        const plan = planChange({ rules: [existing], messages, change });

        expect(plan.takenFrom).toEqual([{ ruleName: 'Alles ins Archiv', count: 2 }]);
    });

    it('warns when a deletion sends mail back to the inbox', () => {
        const existing = rule('r-old', 'Newsletter', 1, 'news@shop.example', 'Newsletter');
        const change: PendingChange = {
            id: 'c3',
            kind: 'delete-rule',
            summary: 'Newsletter löschen',
            before: existing,
        };

        const plan = planChange({ rules: [existing], messages, change });

        expect(plan.returnedToInbox).toBe(2);
        expect(describePlan(plan)).toContain('kommen in den Posteingang zurück');
    });

    it('says plainly when a change moves nothing', () => {
        const change: PendingChange = {
            id: 'c4',
            kind: 'create-rule',
            summary: 'Niemand',
            after: rule('r-new', 'Niemand', 1, 'gibt-es-nicht@example', 'Archiv'),
        };

        expect(describePlan(planChange({ rules: [], messages, change }))).toContain('verschiebt keine');
    });

    it('rewrites the rules that point at a folder being renamed', () => {
        const existing = rule('r1', 'Bahn', 1, 'bahn', 'Kosten/Bahn');
        const renamed = applyChangeToRules([existing], {
            id: 'c5',
            kind: 'rename-folder',
            summary: 'umbenennen',
            folder: { name: 'Bahn', newName: 'Zug' },
        });

        // Without this, a rename leaves every rule pointing at a folder that no longer exists.
        expect(renamed[0]?.rule.Actions.FileInto).toEqual(['Kosten/Zug']);
    });

    it('leaves the original rule set untouched', () => {
        const rules = [rule('r1', 'A', 1, 'x', 'Archiv')];
        applyChangeToRules(rules, { id: 'c6', kind: 'delete-rule', summary: 'x', before: rules[0] });

        expect(rules).toHaveLength(1);
    });
});

describe('undo', () => {
    const created = rule('r-new', 'Newsletter', 1, 'news@shop.example', 'Newsletter');
    const change: PendingChange = { id: 'c1', kind: 'create-rule', summary: 'Newsletter', after: created };

    it('produces the change that reverses each kind', () => {
        expect(inverseOf(change).kind).toBe('delete-rule');
        expect(inverseOf({ id: 'x', kind: 'delete-rule', summary: '', before: created }).kind).toBe(
            'create-rule'
        );
        expect(inverseOf({ id: 'x', kind: 'disable-rule', summary: '', before: created }).kind).toBe(
            'enable-rule'
        );
    });

    it('swaps before and after when undoing an edit', () => {
        const edited = rule('r-new', 'Newsletter neu', 1, 'news@shop.example', 'Archiv');
        const undo = inverseOf({ id: 'x', kind: 'update-rule', summary: '', before: created, after: edited });

        expect(undo.before).toBe(edited);
        expect(undo.after).toBe(created);
    });

    it('reverses a rename in the other direction', () => {
        const undo = inverseOf({
            id: 'x',
            kind: 'rename-folder',
            summary: '',
            folder: { name: 'Bahn', newName: 'Zug' },
        });

        expect(undo.folder).toEqual({ name: 'Zug', newName: 'Bahn', parent: undefined });
    });

    it('restores the rule set and names exactly the messages to move back', () => {
        const journal = new Journal();
        journal.record({
            id: 'e1',
            at: 1000,
            change,
            moved: [
                { messageId: 'm1', previousLabelIds: ['0'], movedTo: 'Newsletter' },
                { messageId: 'm2', previousLabelIds: ['0'], movedTo: 'Newsletter' },
            ],
        });

        const result = journal.undo('e1', [created], 2000);

        expect(result.rules).toHaveLength(0);
        // Exactly the two it moved. Not "everything in Newsletter" — a mail filed there by hand
        // afterwards is not this change's to move.
        expect(result.restore.map((entry) => entry.messageId)).toEqual(['m1', 'm2']);
        expect(result.restore[0]?.previousLabelIds).toEqual(['0']);
    });

    it('refuses to undo the same entry twice', () => {
        const journal = new Journal();
        journal.record({ id: 'e1', at: 1000, change, moved: [] });
        journal.undo('e1', [created], 2000);

        expect(() => journal.undo('e1', [created], 3000)).toThrow(/bereits rückgängig/);
    });

    it('lists the newest entry first', () => {
        const journal = new Journal();
        journal.record({ id: 'old', at: 1000, change, moved: [] });
        journal.record({ id: 'new', at: 2000, change, moved: [] });

        expect(journal.entries.map((entry) => entry.id)).toEqual(['new', 'old']);
    });
});

describe('verifying that Proton did it', () => {
    const expected = [
        { messageId: 'm1', subject: 'a', sender: 'x', from: undefined, to: 'Newsletter' },
        { messageId: 'm2', subject: 'b', sender: 'x', from: undefined, to: 'Newsletter' },
    ];
    const folderIds = new Map([['Newsletter', 'lbl-news']]);

    it('confirms when everything landed', () => {
        const result = verifyMoves({
            expected,
            actual: [
                { ID: 'm1', LabelIDs: ['lbl-news'] },
                { ID: 'm2', LabelIDs: ['lbl-news'] },
            ],
            folderIds,
            now: 1,
        });

        expect(result.confirmed).toBe(2);
        expect(result.stragglers).toEqual([]);
        expect(partialMoveError(result, 'Newsletter')).toBeUndefined();
    });

    it('raises a partial result instead of rounding it up', () => {
        // The state no error code reports: the write succeeded and some mail did not move.
        const result = verifyMoves({
            expected,
            actual: [
                { ID: 'm1', LabelIDs: ['lbl-news'] },
                { ID: 'm2', LabelIDs: ['0'] },
            ],
            folderIds,
            now: 1,
        });

        const error = partialMoveError(result, 'Newsletter');
        expect(error?.code).toBe('VERIFY_PARTIAL_MOVE');
        expect(error?.message).toContain('1 von 2');
    });

    it('treats a message missing from the read-back as unconfirmed', () => {
        const result = verifyMoves({ expected, actual: [{ ID: 'm1', LabelIDs: ['lbl-news'] }], folderIds, now: 1 });

        expect(result.confirmed).toBe(1);
        expect(result.stragglers).toEqual(['m2']);
    });

    it('puts no subject line in the error, only ids', () => {
        const result = verifyMoves({ expected, actual: [], folderIds, now: 1 });
        const serialised = JSON.stringify(partialMoveError(result, 'Newsletter')?.toJSON());

        expect(serialised).not.toContain('Betreff');
        expect(serialised).toContain('m1');
    });
});

describe('the health check', () => {
    it('finds mail a rule should have caught that is still in the inbox', () => {
        // The only check that compares our simulation against the real mailbox rather than itself.
        const findings = findRulesNotFiring(
            [{ id: 'r1', name: 'Newsletter', catches: (message) => message.ID.startsWith('m') }],
            [{ ID: 'm9', LabelIDs: ['0'] }]
        );

        expect(findings).toEqual([{ ruleId: 'r1', ruleName: 'Newsletter', missedMessageIds: ['m9'] }]);
    });

    it('stays quiet when every rule is doing its job', () => {
        expect(
            findRulesNotFiring([{ id: 'r1', name: 'x', catches: () => false }], [{ ID: 'm9', LabelIDs: ['0'] }])
        ).toEqual([]);
    });
});

/**
 * Planning a category move, which is planned backwards from everything else here.
 *
 * `planChange` simulates the rule set and reads the moves out of what changed. A category move has
 * no rule to simulate: the moves *are* the input, because a person selected them. The failure mode
 * that matters is therefore the opposite one — not a missed consequence, but a widened one.
 */
describe('planning a move into one of Protons categories', () => {
    const noCategories = (): string | undefined => undefined;

    it('plans a move for each named message and for no other', () => {
        const plan = planCategoryMove({
            rules: [],
            messages,
            messageIds: ['m1', 'm3'],
            categoryId: '26',
            currentCategoryOf: noCategories,
        });

        expect(plan.moves.map((move) => move.messageId)).toEqual(['m1', 'm3']);
        expect(plan.moves.every((move) => move.to === 'Transaktionen')).toBe(true);
        // The whole authorisation, carried on the change and not recomputed downstream.
        expect(plan.change.category).toEqual({ id: '26', messageIds: ['m1', 'm3'] });
    });

    it('ignores an id that is not in the mailbox rather than inventing a row for it', () => {
        const plan = planCategoryMove({
            rules: [],
            messages,
            messageIds: ['m1', 'gibt-es-nicht'],
            categoryId: '26',
            currentCategoryOf: noCategories,
        });

        expect(plan.moves.map((move) => move.messageId)).toEqual(['m1']);
    });

    it('names the category a message is in today', () => {
        const plan = planCategoryMove({
            rules: [],
            messages,
            messageIds: ['m1'],
            categoryId: '26',
            currentCategoryOf: () => '24',
        });

        // Named, not numbered: „24 → 26" is not a sentence anyone can check against their mailbox.
        expect(plan.moves[0]?.from).toBe('Standard');
    });

    it('claims nothing about the inbox, because nothing is known about it', () => {
        // Proton's client sends one label request and no unlabel, which says something about the
        // previous category and nothing at all about the inbox. A number here would be a guess with
        // a count next to it.
        const plan = planCategoryMove({
            rules: [],
            messages,
            messageIds: ['m1', 'm2'],
            categoryId: '26',
            currentCategoryOf: noCategories,
        });

        expect(plan.clearedFromInbox).toBe(0);
        expect(plan.returnedToInbox).toBe(0);
    });

    it('says which of your own rules is already handling this mail', () => {
        // The duplicate warning, in the last place before a write. Proton is about to sort this
        // mail and a rule of the user's own already does — that is the thing worth seeing.
        const plan = planCategoryMove({
            rules: [rule('r-1', 'Shop', 1, 'news@shop.example', 'Werbung')],
            messages,
            messageIds: ['m1', 'm2'],
            categoryId: '21',
            currentCategoryOf: noCategories,
        });

        expect(plan.takenFrom).toEqual([{ ruleName: 'Shop', count: 2 }]);
    });

    it('leaves the rules untouched', () => {
        const rules = [rule('r-1', 'Shop', 1, 'news@shop.example', 'Werbung')];
        const plan = planCategoryMove({
            rules,
            messages,
            messageIds: ['m1'],
            categoryId: '26',
            currentCategoryOf: noCategories,
        });

        expect(applyChangeToRules(rules, plan.change)).toEqual(rules);
    });

    it('has an inverse that names no destination, because the messages do not share one', () => {
        const plan = planCategoryMove({
            rules: [],
            messages,
            messageIds: ['m1', 'm3'],
            categoryId: '26',
            currentCategoryOf: noCategories,
        });

        const inverse = inverseOf(plan.change);
        expect(inverse.kind).toBe('move-to-category');
        // Undo works from the journal's per-message snapshot instead. Naming one category here
        // would send every message back to the same place, which is only right by accident.
        expect(inverse.category).toBeUndefined();
    });
});
