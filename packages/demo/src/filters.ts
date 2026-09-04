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
        // First, so the specific rules below override it. A catch-all placed last would make every
        // other rule ineffective at once, which is true but teaches nothing: the point is to show
        // one rule quietly doing nothing, not a wall of red.
        id: 'r-catchall',
        name: 'Alles Übrige ins Archiv',
        priority: 1,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['@'], 'Archiv'),
    },
    {
        id: 'r-bahn',
        name: 'Bahn-Tickets',
        priority: 2,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['billing@bahn.example'], 'Kosten Bestellung/Bahn'),
    },
    {
        id: 'r-lohn',
        name: 'Lohnabrechnungen',
        priority: 3,
        enabled: true,
        authoredAs: 'sieve',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['lohn@arbeitgeber.example'], 'Lohn'),
    },
    {
        id: 'r-alt',
        name: 'Alter Arbeitgeber',
        priority: 4,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['@ehemaliger-arbeitgeber.example'], 'Archiv'),
    },
    {
        // The instructive one. It looks correct, it matches plenty, and it never decides anything:
        // "Werbung wegsortieren" below targets the same sender and runs later, so the newsletters
        // the user believes are in Newsletter are actually in Junk. Nothing in Proton's own filter
        // list would reveal this.
        id: 'r-newsletter',
        name: 'Newsletter sammeln',
        priority: 5,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['newsletter@versandhaus.example'], 'Newsletter'),
    },
    {
        id: 'r-junk',
        name: 'Werbung wegsortieren',
        priority: 6,
        enabled: true,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['newsletter@versandhaus.example'], 'Junk'),
    },
    {
        // Switched off in Proton's own interface, which is a state the dashboard has to render
        // honestly and used to get wrong: the list called it „aktiv", in green, because the only
        // badge it had was a verdict about how well the rule works. A rule that does not run works
        // neither well nor badly.
        //
        // It is in the demo because a state nothing exercises is a state nobody notices breaking,
        // and because a switched-off rule is exactly the sort of thing a real mailbox accumulates.
        id: 'r-abgeschaltet',
        name: 'Rechnungen ablegen (pausiert)',
        priority: 7,
        enabled: false,
        authoredAs: 'tree',
        rule: rule(ConditionType.SENDER, ConditionComparator.CONTAINS, ['rechnung@'], 'Rechnungen'),
    },
];
