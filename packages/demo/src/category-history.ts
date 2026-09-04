import { CATEGORY_LABELS } from '@pms/grouping';

import { generateMailbox } from './mailbox.js';

/**
 * A synthetic record of Proton sorting mail, over six pretend syncs.
 *
 * The demo needs one because the „Auto-Regeln" screen has nothing else to render, and a screen that
 * only works against a real account has been testing itself. But it has to be honest in a specific
 * way: the interesting states there are *uncertainty* and *change*, so a tidy history where every
 * sender is settled would make the screen look finished while proving nothing.
 *
 * So it contains, on purpose:
 *
 *  - a sender Proton has filed the same way every time — the boring, common case;
 *  - one it **changed its mind about** halfway through, which is the whole reason the screen exists;
 *  - one it splits between two categories, where a rule of the user's own is the right answer;
 *  - one seen exactly once, which must come back as „not enough looks yet" rather than a verdict;
 *  - a domain whose senders agree, so the sender and domain views say different things.
 *
 * The timestamps are fixed rather than relative to now: a demo that reads „vor 3 Minuten" on every
 * screen tells you nothing about whether the dates are being computed correctly.
 */

/** Six daily syncs ending 2026-08-20, so the screen has a plausible span to describe. */
const LAST_SYNC = 1_755_648_000;
const DAY = 86_400;
export const DEMO_SYNC_TIMES = [5, 4, 3, 2, 1, 0].map((back) => LAST_SYNC - back * DAY);

export interface DemoObservation {
    senderAddress: string;
    senderDomain: string;
    categoryId: string;
    observedAt: number;
    messageCount: number;
}

export interface DemoCategoryChange {
    messageId: string;
    senderAddress: string;
    fromCategory: string | undefined;
    toCategory: string;
    observedAt: number;
}

function at(index: number): number {
    return DEMO_SYNC_TIMES[index] ?? LAST_SYNC;
}

function observations(
    address: string,
    plan: Array<{ sync: number; categoryId: string; count: number }>
): DemoObservation[] {
    const domain = address.split('@')[1] ?? '';
    return plan.map((entry) => ({
        senderAddress: address,
        senderDomain: domain,
        categoryId: entry.categoryId,
        observedAt: at(entry.sync),
        messageCount: entry.count,
    }));
}

const STEADY = 'newsletter@wochenblatt.example';
const CHANGED = 'angebote@grossverteiler.example';
const SPLIT = 'info@verein.example';
const NEW = 'erstkontakt@unbekannt.example';
const FIRST_SEEN = 'rechnung@handwerk.example';
const SIBLING = 'kasse@grossverteiler.example';

export const DEMO_CATEGORY_OBSERVATIONS: DemoObservation[] = [
    // Settled from the start: six looks, always Newsletter.
    ...observations(
        STEADY,
        [0, 1, 2, 3, 4, 5].map((sync) => ({ sync, categoryId: '25', count: 7 }))
    ),

    // Proton changed its mind at sync 3: Standard until then, Werbung after. This is the case the
    // screen is built around, and the one that is invisible without a history.
    ...observations(CHANGED, [
        { sync: 0, categoryId: '24', count: 4 },
        { sync: 1, categoryId: '24', count: 5 },
        { sync: 2, categoryId: '24', count: 5 },
        { sync: 3, categoryId: '21', count: 6 },
        { sync: 4, categoryId: '21', count: 6 },
        { sync: 5, categoryId: '21', count: 7 },
    ]),

    // Its sibling agrees, so the domain view can say something the sender view cannot.
    ...observations(SIBLING, [
        { sync: 3, categoryId: '21', count: 2 },
        { sync: 4, categoryId: '21', count: 2 },
        { sync: 5, categoryId: '21', count: 3 },
    ]),

    // Genuinely undecided — roughly half and half, every time. A user rule is legitimate here, and
    // the screen should say so rather than picking a winner.
    ...observations(SPLIT, [
        { sync: 2, categoryId: '22', count: 4 },
        { sync: 2, categoryId: '25', count: 3 },
        { sync: 3, categoryId: '22', count: 4 },
        { sync: 3, categoryId: '25', count: 4 },
        { sync: 4, categoryId: '22', count: 5 },
        { sync: 4, categoryId: '25', count: 4 },
    ]),

    // Seen once. Must read as "not enough looks yet", however much mail it brought.
    ...observations(NEW, [{ sync: 5, categoryId: '26', count: 9 }]),

    // Had no category at all, then gained one. Kept separate from NEW on purpose: a sender cannot
    // demonstrate both "nothing to say yet" and "here is what happened", because the second answer
    // always wins — and the demo needs to show both wordings.
    ...observations(FIRST_SEEN, [
        { sync: 4, categoryId: '26', count: 2 },
        { sync: 5, categoryId: '26', count: 3 },
    ]),
];

export const DEMO_CATEGORY_CHANGES: DemoCategoryChange[] = [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
        messageId: `demo-change-${String(n)}`,
        senderAddress: CHANGED,
        fromCategory: '24' as string | undefined,
        toCategory: '21',
        observedAt: at(3),
    })),
    // A first sighting rather than a change of mind: no `from`, and the screen words it differently.
    {
        messageId: 'demo-first-1',
        senderAddress: FIRST_SEEN,
        fromCategory: undefined,
        toCategory: '26',
        observedAt: at(4),
    },
];

/**
 * The category ids the demo history talks about, so a screen can be checked against the map.
 *
 * Every id used above must be one Proton actually has — a demo that invents a category would make
 * the „unbekannte Kategorie" notice fire on data we wrote ourselves, and that notice is supposed to
 * mean something.
 */
export const DEMO_CATEGORY_IDS = [...new Set(DEMO_CATEGORY_OBSERVATIONS.map((entry) => entry.categoryId))];

/** Guard rail for the fixture above; `generateMailbox` is imported so the module stays cohesive. */
export function demoHistoryIsWellFormed(): boolean {
    return DEMO_CATEGORY_IDS.every((id) => id in CATEGORY_LABELS) && generateMailbox().length > 0;
}
