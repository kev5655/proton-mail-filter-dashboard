import { CATEGORY_LABELS } from './group.js';
import { emailDomain } from './normalize.js';

/**
 * Reading Proton's invisible sorting rule off its own behaviour.
 *
 * Proton files inbox mail into categories, and once a message has been moved into one by hand it
 * keeps doing the same for that sender. There is no way to ask it about that. Its own client sends
 * nothing when it recategorises — `useRecategorizeElement.ts` in WebClients issues the move and
 * nothing else — and there is no endpoint that reads or writes a per-sender preference. The rule
 * exists on their servers and is visible only in what it does.
 *
 * So this infers, from repeated observation, and the whole design turns on being honest about the
 * difference between the two sentences:
 *
 *   - *"Proton sorts this sender into Werbung."*  ← a rule. We cannot say this.
 *   - *"Every time we looked, this sender's mail was in Werbung."*  ← an observation. We can.
 *
 * Every verdict below is the second kind, and the screen that renders them says so. The thresholds
 * are deliberately conservative because the cost of the two mistakes is not symmetric: claiming a
 * pattern that is not there sends someone to change a rule for no reason, while saying "not enough
 * to tell yet" merely asks them to wait, which is true and costs nothing.
 *
 * Four things this cannot see, all of which belong in front of the user rather than in this comment
 * alone:
 *
 *  1. **An incremental sync only fetches new mail.** If Proton recategorises a message that arrived
 *     last month, we never look at it again and never notice. "Unchanged" here means *unobserved*,
 *     not confirmed. Only a full `pnpm sync` re-reads the back catalogue.
 *  2. **The user moves mail too**, in Proton's web and mobile apps. A change we record may be
 *     theirs, and nothing distinguishes the two.
 *  3. **The sync window and the message cap leave holes**, so consecutive observations are not
 *     necessarily consecutive in the mailbox's life.
 *  4. **History starts at the migration.** There is no retrospective view, and a sender with one
 *     observation is a sender we know nothing about yet — which is what `too-few` says.
 */

/** One observation: at time T, this sender had this many messages in this category. */
export interface CategoryObservation {
    senderAddress: string;
    senderDomain: string;
    categoryId: string;
    observedAt: number;
    messageCount: number;
}

/** A category a message left, and when. Built from `message_categories`. */
export interface CategoryChange {
    messageId: string;
    senderAddress: string;
    fromCategory: string | undefined;
    toCategory: string;
    observedAt: number;
}

export type AutoRuleVerdict =
    /** Every observation agreed, over enough syncs to mean something. */
    | { kind: 'stable'; categoryId: string; since: number; syncs: number; messages: number }
    /** The category changed between two observations — Proton doing something new. */
    | { kind: 'changed'; from: string | undefined; to: string; at: number; messages: number }
    /** No category holds a clear majority. A rule of your own is legitimate here. */
    | { kind: 'mixed'; shares: Array<{ categoryId: string; count: number }> }
    /** Not enough looks yet. The honest answer on a young database, and the default. */
    | { kind: 'too-few'; syncs: number };

export interface AutoRule {
    scope: { kind: 'sender'; address: string } | { kind: 'domain'; domain: string };
    verdict: AutoRuleVerdict;
    /** The sync timestamps this rests on. Shown, never hidden — they are the entire basis. */
    observedOver: number[];
}

/**
 * How much looking is enough.
 *
 * Two syncs is the minimum at which the word "consistently" means anything at all, and three
 * messages the minimum at which one oddly-filed mail cannot carry the verdict on its own. Both are
 * low, because the alternative to a cautious statement here is no statement, and the screen is
 * explicit about the basis either way.
 */
export const MIN_SYNCS_FOR_STABLE = 2;
export const MIN_MESSAGES_FOR_STABLE = 3;
/** Below this share of a sender's mail, no category is called dominant. */
export const DOMINANT_SHARE = 0.8;

export interface DeriveInput {
    observations: readonly CategoryObservation[];
    changes: readonly CategoryChange[];
}

/**
 * One verdict per sender, plus one per domain.
 *
 * Both, deliberately. We do not know whether Proton decides by sender, by domain, by content or by
 * something else entirely, and choosing one would be presenting a guess as a finding. Showing the
 * two side by side lets the person looking at their own mail see which explanation fits — which is
 * a question they can answer and we cannot.
 */
export function deriveAutoRules(input: DeriveInput): AutoRule[] {
    const bySender = new Map<string, CategoryObservation[]>();
    const byDomain = new Map<string, CategoryObservation[]>();

    for (const observation of input.observations) {
        push(bySender, observation.senderAddress, observation);
        push(byDomain, observation.senderDomain, observation);
    }

    const changesBySender = new Map<string, CategoryChange[]>();
    for (const change of input.changes) {
        push(changesBySender, change.senderAddress, change);
    }

    const rules: AutoRule[] = [];

    for (const [address, observations] of bySender) {
        rules.push({
            scope: { kind: 'sender', address },
            verdict: verdictFor(observations, changesBySender.get(address) ?? []),
            observedOver: syncTimes(observations),
        });
    }

    for (const [domain, observations] of byDomain) {
        // A domain with one sender says nothing the sender does not already say.
        if (new Set(observations.map((entry) => entry.senderAddress)).size < 2) {
            continue;
        }
        rules.push({
            scope: { kind: 'domain', domain },
            verdict: verdictFor(observations, []),
            observedOver: syncTimes(observations),
        });
    }

    return rules.sort((a, b) => weight(b) - weight(a));
}

/**
 * The verdict for one set of observations.
 *
 * Order matters: a *change* outranks stability, because "this used to go elsewhere and now goes
 * here" is the interesting sentence and would otherwise be swallowed by the majority that follows
 * it. A sender Proton re-sorted yesterday is exactly the one worth looking at.
 */
function verdictFor(
    observations: readonly CategoryObservation[],
    changes: readonly CategoryChange[]
): AutoRuleVerdict {
    const times = syncTimes(observations);

    const latest = [...changes].sort((a, b) => b.observedAt - a.observedAt)[0];
    if (latest !== undefined) {
        const together = changes.filter(
            (change) => change.observedAt === latest.observedAt && change.toCategory === latest.toCategory
        );
        return {
            kind: 'changed',
            from: latest.fromCategory,
            to: latest.toCategory,
            at: latest.observedAt,
            messages: together.length,
        };
    }

    if (times.length < MIN_SYNCS_FOR_STABLE) {
        return { kind: 'too-few', syncs: times.length };
    }

    // Per category, the largest count seen in any single sync — not the sum. Summing across syncs
    // would count the same message once per time we looked at it, so a sender observed ten times
    // would look ten times busier than one observed once.
    const peak = new Map<string, number>();
    for (const observation of observations) {
        const current = peak.get(observation.categoryId) ?? 0;
        peak.set(observation.categoryId, Math.max(current, observation.messageCount));
    }

    const shares = [...peak.entries()]
        .map(([categoryId, count]) => ({ categoryId, count }))
        .sort((a, b) => b.count - a.count);

    const total = shares.reduce((sum, entry) => sum + entry.count, 0);
    const leader = shares[0];

    if (leader === undefined || total === 0) {
        return { kind: 'too-few', syncs: times.length };
    }
    if (leader.count / total < DOMINANT_SHARE) {
        return { kind: 'mixed', shares };
    }
    if (leader.count < MIN_MESSAGES_FOR_STABLE) {
        return { kind: 'too-few', syncs: times.length };
    }

    return {
        kind: 'stable',
        categoryId: leader.categoryId,
        since: times[0] ?? 0,
        syncs: times.length,
        messages: leader.count,
    };
}

/** Distinct observation times, oldest first. The count of these is "how often we looked". */
function syncTimes(observations: readonly CategoryObservation[]): number[] {
    return [...new Set(observations.map((entry) => entry.observedAt))].sort((a, b) => a - b);
}

/** Sort order: what changed first, then what is well established, then the rest. */
function weight(rule: AutoRule): number {
    switch (rule.verdict.kind) {
        case 'changed':
            return 1_000_000 + rule.verdict.at / 1_000;
        case 'stable':
            return 1_000 + rule.verdict.messages;
        case 'mixed':
            return 100;
        case 'too-few':
            return 0;
    }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list === undefined) {
        map.set(key, [value]);
    } else {
        list.push(value);
    }
}

/** The display name for a category id, or a phrasing that admits we do not have one. */
export function categoryName(categoryId: string): string {
    return CATEGORY_LABELS[categoryId] ?? `Unbekannte Kategorie ${categoryId}`;
}

/** Re-exported so callers deriving a domain do it the way the observations were recorded. */
export { emailDomain };
