import {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type SimpleObject,
} from '@proton/sieve/filterModel';
import type { OrderedRule } from '@pms/rules';

/**
 * The filters the demo mailbox starts with.
 *
 * Chosen to make the dashboard show the things it exists to show, rather than a tidy list where
 * everything works:
 *
 *   - one rule that does its job,
 *   - one that matches plenty of mail but never decides where it goes, because a later catch-all
 *     overrides it — the failure Proton's own filter list cannot reveal,
 *   - one that matches nothing at all any more,
 *   - and one filing into a folder left over from an IMAP migration, which quietly moves mail
 *     somewhere the user never looks.
 */

function rule(
    type: ConditionType,
    comparator: ConditionComparator,
    values: string[],
    folder: string
): SimpleObject {
    return {
        Operator: { label: 'all', value: FilterStatement.ALL },
        Conditions: [
            {
                Type: { label: type, value: type },
                Comparator: { label: comparator, value: comparator },
                Values: values,
            },
        ],
        Actions: { FileInto: [folder], Mark: { Read: false, Starred: false } },
    };
}

export interface DemoRule extends OrderedRule {
    /** Sieve-authored rules have no Simple field in the API and cannot be edited in Proton's UI. */
    authoredAs: 'tree' | 'sieve';
}

export const DEMO_RULES: DemoRule[] = [
    {
        id: 'r-bahn',
        name: 'Bahn-Tickets',
        priority: 1,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['billing@bahn.example'], 'Kosten Bestellung/Bahn'),
    },
    {
        id: 'r-lohn',
        name: 'Lohnabrechnungen',
        priority: 2,
        enabled: true,
        authoredAs: 'sieve',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['lohn@arbeitgeber.example'], 'Lohn'),
    },
    {
        id: 'r-alt',
        name: 'Alter Arbeitgeber',
        priority: 3,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['@ehemaliger-arbeitgeber.example'], 'Archiv'),
    },
    {
        id: 'r-junk',
        name: 'Werbung wegsortieren',
        priority: 4,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['newsletter@versandhaus.example'], 'Junk'),
    },
    {
        id: 'r-catchall',
        name: 'Alles Übrige ins Archiv',
        priority: 5,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['@'], 'Archiv'),
    },
];
