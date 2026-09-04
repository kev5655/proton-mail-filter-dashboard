import type { SimpleObject } from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';

import { INBOX } from '@pms/demo';
import type { MailboxFolder, MailboxMessage, MailboxRule } from '@pms/server/types';
import {
    categoryIdsOf,
    CATEGORY_IDS,
    CATEGORY_LABELS,
    deriveAutoRules,
    groupMessages,
    scoreGroups,
    type AutoRule,
    type CategoryChange,
    type CategoryObservation,
    type ScoredGroup,
} from '@pms/grouping';
import {
    analyseRules,
    matchesRule,
    protonEscapingIsBroken,
    ruleFromGroup,
    type OrderedRule,
    type RuleAnalysis,
} from '@pms/rules';

/**
 * Everything the interface shows, derived from one mailbox.
 *
 * A function of its input rather than a module of constants, because there are now two inputs: the
 * demo mailbox and the real one the local server mirrors. The screens must not be able to tell
 * which they were given — a dashboard that only works on the demo has been testing itself.
 *
 * The point of wiring the real engine to the data rather than mocking the screens still holds: what
 * appears here is genuinely what the matcher, the grouping and the conflict analysis produce. If a
 * preview looks wrong on screen, the bug is in the logic and not in a fixture someone typed to look
 * nice.
 */

export interface MailboxInput {
    messages: MailboxMessage[];
    folders: MailboxFolder[];
    /**
     * The account's own labels, which are not folders.
     *
     * Proton stores both as the same object with a different `Type`, and the difference is what a
     * rule does with them: a folder *moves* the mail, a label *marks* it and leaves it in the
     * inbox. They were mirrored, they reached the snapshot, and the dashboard threw them away.
     *
     * That was not only a missing feature. `categoryIdsOf` decides what counts as one of Proton's
     * categories by elimination — a short numeric id that is not a system location and not a known
     * folder — so every real label was being reported to the user as an unknown category.
     */
    labels?: MailboxFolder[];
    rules: MailboxRule[];
    /**
     * What Proton's own sorting has been observed doing, across syncs.
     *
     * Optional because a copy made before the history existed has none, and a fresh one has almost
     * none. Absent is a real state with a real answer — "not enough looks yet" — not a gap to fill
     * in with a guess.
     */
    categoryObservations?: readonly CategoryObservation[];
    categoryChanges?: readonly CategoryChange[];
}

/**
 * What every rule together does to one message.
 *
 * Computed once for the whole mailbox rather than per question, because the naive shape of this —
 * calling `resolveOutcome` wherever the answer is needed — sorts and filters the rule array *per
 * message*. Asking "how much mail lands in this folder" for fifteen folders then costs fifteen
 * full passes with a sort inside each, and a per-row "which rule catches this" badge would be
 * unaffordable outright.
 */
export interface Outcome {
    /** Where it ends up once every rule has run. Undefined means it stays in the inbox. */
    destination: string | undefined;
    /** The rule whose fileinto won — the last one, since a later rule moves it again. */
    decidedBy: { id: string; name: string } | undefined;
    /** Every rule that matches, in execution order. Several can. */
    matching: OrderedRule[];
    /** Labels the matching rules put on it. A label marks the mail; it does not move it. */
    labels: string[];
}

/**
 * One of Proton's own categories, as it appears in this mailbox.
 *
 * Proton sorts these itself once a message has been filed there by hand, so none of them needs a
 * rule. The screen exists to make that visible — and to show where a *user* rule is doing work
 * Proton already does, which is the only actionable thing on it.
 */
export interface CategorySummary {
    id: string;
    label: string;
    messages: MailboxMessage[];
    inInbox: number;
    topSenders: Array<{ address: string; count: number }>;
    /** Own rules that also move mail Proton already categorised — usually redundant. */
    alsoMovedByRules: Array<{ ruleId: string; ruleName: string; destination: string; count: number }>;
    /** True for a label id that is not in `CATEGORY_LABELS`. Reported, never hidden. */
    unknown: boolean;
}

export interface MailboxData extends MailboxInput {
    inboxMessages: MailboxMessage[];
    groups: ScoredGroup[];
    analysis: RuleAnalysis[];
    suggestions: Suggestion[];
    shadowFolders: MailboxFolder[];
    byId: Map<string, MailboxMessage>;
    outcomes: Map<string, Outcome>;
    /** The rule that decides where this message goes, when one does. */
    caughtBy: (messageId: string) => { ruleId: string; ruleName: string; destination: string } | undefined;
    /** Proton's own categories present in this mailbox, in Proton's order, unknown ids last. */
    categories: CategorySummary[];
    /** What Proton's sorting has been observed doing, per sender and per domain. */
    autoRules: AutoRule[];
    /** The verdict for one sender, when there is one. */
    autoRuleFor: (address: string) => AutoRule | undefined;
    /** The account's own labels — a rule target that marks rather than moves. */
    labels: MailboxFolder[];
    /** Whether a rule's destination name is a label rather than a folder. */
    isLabelName: (name: string) => boolean;
    /**
     * Which of Proton's categories one message carries today, if any.
     *
     * The „bisher" column of a category move's diff. A message can in principle carry two, and this
     * answers with the first — the diff shows one destination and one origin, and inventing a
     * second row for a state we have never observed would be furnishing the screen with a
     * hypothetical.
     */
    categoryOfMessage: (messageId: string) => string | undefined;
    /**
     * Which of Proton's categories these messages already carry.
     *
     * The answer to "is the rule I am about to write doing work Proton already does". Reads the
     * categories computed above rather than walking the mailbox again.
     */
    categoryCoverage: (
        messageIds: readonly string[]
    ) => Array<{ categoryId: string; label: string; count: number; stable: boolean }>;
    /** Every message of a group, not the five samples the grouping keeps for a preview. */
    messagesInGroup: (group: ScoredGroup) => MailboxMessage[];
    analysisFor: (ruleId: string) => RuleAnalysis | undefined;
    matchedBy: (ruleId: string, limit?: number) => MailboxMessage[];
    destinationOf: (message: MailboxMessage) => string | undefined;
    messageCountIn: (folderName: string) => number;
    sieveTextFor: (ruleId: string) => string;
    rulesTargeting: (folderName: string) => MailboxRule[];
}

export interface Suggestion {
    group: ScoredGroup;
    folder: string;
    /** The compiled rule, so accepting stages exactly what was previewed. */
    rule: SimpleObject;
    explanation: string;
    /** Values Proton's escaping would mangle; empty for every suggestion we generate. */
    warnings: string[];
    /** How many of the group's messages the suggested rule would actually catch. */
    covered: number;
}

/**
 * Pick a destination folder for a group.
 *
 * Deliberately dumb for now: match against the folder names that already exist, and otherwise
 * propose a new one derived from the sender's organisation. The language model that will do this
 * properly is M3; until then a transparent guess the user corrects beats a clever one they cannot
 * predict.
 */
function proposeFolder(group: ScoredGroup): string {
    const haystack = `${group.match.sender ?? ''} ${group.match.domain ?? ''} ${group.match.subjectTemplate ?? ''}`.toLowerCase();

    if (haystack.includes('anmeldung') || haystack.includes('security')) {
        return 'Security-Meldung';
    }
    if (haystack.includes('rechnung') || haystack.includes('abrechnung')) {
        return 'Kosten Bestellung';
    }

    /*
     * There used to be a branch here proposing a folder named "Newsletter" *because* Proton had
     * already filed the group under Newsletter or Werbung. That is the duplicate filter this tool
     * exists to prevent, suggested by the tool itself: a rule that moves mail Proton already sorts,
     * into a folder that duplicates a category the user can already click.
     *
     * The category is still worth knowing — it is shown beside the suggestion, and the rule editor
     * says how much of the match Proton already handles — but it must not be the *reason* for a
     * destination.
     */

    const organisation = (group.match.domain ?? group.match.sender?.split('@')[1] ?? 'Diverses').split('.')[0];
    return organisation === undefined || organisation === ''
        ? 'Diverses'
        : organisation.charAt(0).toUpperCase() + organisation.slice(1);
}

/**
 * Derive everything the screens read from one mailbox.
 *
 * Called once per source. Nothing in here reaches for a module-level constant, which is what makes
 * the demo and the real account interchangeable rather than merely similar.
 */
export function buildMailbox(input: MailboxInput): MailboxData {
    const labels = input.labels ?? [];
    /*
     * Label names, for the one question the matcher cannot answer on its own.
     *
     * Proton's filter model has no label action: a rule's destination is a name in `FileInto`, and
     * whether that name resolves to a folder or a label is decided at Proton. So predicting what a
     * rule *does* — moves the mail out of the inbox, or marks it and leaves it — needs this set,
     * and without it the preview would claim mail leaves the inbox when it does not.
     */
    const labelNames = new Set(labels.map((label) => label.Name));
    const { messages, folders, rules } = input;

    const inboxMessages = messages.filter((message) => message.LabelIDs.includes(INBOX));
    const groups = scoreGroups(groupMessages(inboxMessages));
    const analysis = analyseRules(rules, messages);

    const byId = new Map(messages.map((message) => [message.ID, message]));

    /*
     * The execution order, hoisted out of the loop.
     *
     * `resolveOutcome` does this filter and sort itself, on every call. Doing it once here is the
     * whole difference between one pass over the mailbox and one pass per question asked.
     */
    const ordered = rules.filter((entry) => entry.enabled).sort((a, b) => a.priority - b.priority);

    /**
     * Where every message ends up, in one pass.
     *
     * Not the same as "which rules match": several can, and the last one to file it wins. Showing
     * only the matches would tell the user something true and useless — so the deciding rule is
     * recorded alongside, which is what lets a suggestion say "this is already caught by X".
     */
    const outcomes = new Map<string, Outcome>();
    for (const message of messages) {
        const matching: OrderedRule[] = [];
        let destination: string | undefined;
        let decidedBy: { id: string; name: string } | undefined;

        const applied: string[] = [];
        for (const entry of ordered) {
            if (!matchesRule(entry.rule, message)) {
                continue;
            }
            matching.push(entry);
            for (const target of entry.rule.Actions.FileInto) {
                if (target === '') {
                    continue;
                }
                /*
                 * A label is not a destination.
                 *
                 * Proton's filter model has no label action — the name goes in `FileInto` either
                 * way, and Proton decides what it means by which object carries it. A folder moves
                 * the mail out of the inbox; a label marks it and leaves it. Counting a label as a
                 * destination would make every preview claim mail leaves the inbox when it does not.
                 */
                if (labelNames.has(target)) {
                    if (!applied.includes(target)) {
                        applied.push(target);
                    }
                    continue;
                }
                destination = target;
                decidedBy = { id: entry.id, name: entry.name };
            }
        }

        outcomes.set(message.ID, { destination, decidedBy, matching, labels: applied });
    }

    const destinationOf = (message: MailboxMessage): string | undefined =>
        outcomes.get(message.ID)?.destination;

    /** Folder totals, from the one pass above rather than a scan per folder. */
    const countsByFolder = new Map<string, number>();
    for (const outcome of outcomes.values()) {
        if (outcome.destination !== undefined) {
            countsByFolder.set(outcome.destination, (countsByFolder.get(outcome.destination) ?? 0) + 1);
        }
    }

    /** Which messages each rule catches, from the same pass. Uncapped — the caller paginates. */
    const matchedByRule = new Map<string, MailboxMessage[]>();
    for (const [id, outcome] of outcomes) {
        const message = byId.get(id);
        if (message === undefined) {
            continue;
        }
        for (const entry of outcome.matching) {
            const list = matchedByRule.get(entry.id);
            if (list === undefined) {
                matchedByRule.set(entry.id, [message]);
            } else {
                list.push(message);
            }
        }
    }

    // Groups are stable for the life of this mailbox, so resolving one is worth remembering.
    const groupMembers = new Map<string, MailboxMessage[]>();

    /*
     * Proton's own categories.
     *
     * They arrive as ordinary entries in `LabelIDs`, mixed in with folders and labels, so the id is
     * the only thing separating them. `categoryIdsOf` is the single definition of which ids count —
     * shared with the sync engine, which writes the same judgement into the history. Two copies of
     * this rule is how `16` and `40` came to be missing from one of them, and a snoozed message was
     * reported to the user as an unknown category.
     *
     * An unrecognised id is still reported, marked unknown. Dropping it would hide exactly the
     * evidence needed to correct the map.
     */
    // Folders *and* labels: an id that belongs to either is not a category. Leaving the labels out
    // is how every real label came to be reported as an unknown Proton category.
    const knownFolderIds = new Set([...folders, ...labels].map((entry) => entry.ID));
    const byCategory = new Map<string, MailboxMessage[]>();

    for (const message of messages) {
        for (const labelId of categoryIdsOf(message.LabelIDs, knownFolderIds)) {
            const list = byCategory.get(labelId);
            if (list === undefined) {
                byCategory.set(labelId, [message]);
            } else {
                list.push(message);
            }
        }
    }

    const categories: CategorySummary[] = [...byCategory.entries()]
        .map(([id, list]) => {
            const senders = new Map<string, number>();
            for (const message of list) {
                senders.set(message.Sender.Address, (senders.get(message.Sender.Address) ?? 0) + 1);
            }

            // Which of the user's own rules also move this mail. Proton has already sorted it, so
            // a rule doing the same work is one more thing to keep in step for no gain.
            const byRule = new Map<string, { ruleId: string; ruleName: string; destination: string; count: number }>();
            for (const message of list) {
                const owner = outcomes.get(message.ID)?.decidedBy;
                const destination = outcomes.get(message.ID)?.destination;
                if (owner === undefined || destination === undefined) {
                    continue;
                }
                const existing = byRule.get(owner.id);
                if (existing === undefined) {
                    byRule.set(owner.id, { ruleId: owner.id, ruleName: owner.name, destination, count: 1 });
                } else {
                    existing.count++;
                }
            }

            return {
                id,
                label: CATEGORY_LABELS[id] ?? `Unbekannte Kategorie ${id}`,
                messages: list,
                inInbox: list.filter((message) => message.LabelIDs.includes(INBOX)).length,
                topSenders: [...senders.entries()]
                    .map(([address, count]) => ({ address, count }))
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 5),
                alsoMovedByRules: [...byRule.values()].sort((a, b) => b.count - a.count),
                unknown: !(id in CATEGORY_LABELS),
            };
        })
        .sort((a, b) => order(a.id) - order(b.id) || b.messages.length - a.messages.length);

    const suggestions: Suggestion[] = groups.map((group) => {
        const folder = proposeFolder(group);
        const { rule, explanation } = ruleFromGroup(
            {
                kind: group.kind,
                ...(group.match.sender === undefined ? {} : { sender: group.match.sender }),
                ...(group.match.domain === undefined ? {} : { domain: group.match.domain }),
                ...(group.match.subjectTemplate === undefined
                    ? {}
                    : { subjectTemplate: group.match.subjectTemplate }),
            },
            folder
        );

        const groupMessageIds = new Set(group.messageIds);
        const covered = messages.filter(
            (message) => groupMessageIds.has(message.ID) && matchesRule(rule, message)
        ).length;

        return {
            group,
            folder,
            rule,
            explanation,
            warnings: protonEscapingIsBroken(rule).map((warning) => `„${warning.value}": ${warning.reason}`),
            covered,
        };
    });

    /*
     * What Proton's own sorting has been observed doing.
     *
     * Derived once here rather than per screen: the rule editor asks "does Proton already handle
     * this sender" on every keystroke of a live preview, and the answer must not cost a pass over
     * the history each time.
     */
    const autoRules = deriveAutoRules({
        observations: input.categoryObservations ?? [],
        changes: input.categoryChanges ?? [],
    });
    const autoRuleBySender = new Map(
        autoRules
            .filter((rule) => rule.scope.kind === 'sender')
            .map((rule) => [rule.scope.kind === 'sender' ? rule.scope.address : '', rule])
    );

    /** Category id per message, so coverage is a lookup rather than a scan. */
    const categoryOf = new Map<string, string[]>();
    for (const summary of categories) {
        for (const message of summary.messages) {
            const list = categoryOf.get(message.ID);
            if (list === undefined) {
                categoryOf.set(message.ID, [summary.id]);
            } else {
                list.push(summary.id);
            }
        }
    }

    return {
        messages,
        folders,
        rules,
        inboxMessages,
        autoRules,
        autoRuleFor: (address) => autoRuleBySender.get(address),
        labels,
        isLabelName: (name) => labelNames.has(name),
        categoryOfMessage: (messageId) => categoryOf.get(messageId)?.[0],

        /*
         * How much of a set of messages Proton already sorts, and how sure we are.
         *
         * `stable` is the difference between "this mail is in Werbung today" and "Proton has put
         * this sender in Werbung every time we looked". The first is a fact about one snapshot and
         * the second is worth changing a plan over, so the sentence on screen has to distinguish
         * them rather than averaging them into a number.
         */
        categoryCoverage: (messageIds) => {
            const counts = new Map<string, { count: number; stableSenders: number }>();

            for (const id of messageIds) {
                const message = byId.get(id);
                for (const categoryId of categoryOf.get(id) ?? []) {
                    const entry = counts.get(categoryId) ?? { count: 0, stableSenders: 0 };
                    entry.count++;
                    const verdict = message === undefined
                        ? undefined
                        : autoRuleBySender.get(message.Sender.Address)?.verdict;
                    if (verdict?.kind === 'stable' && verdict.categoryId === categoryId) {
                        entry.stableSenders++;
                    }
                    counts.set(categoryId, entry);
                }
            }

            return [...counts.entries()]
                .map(([categoryId, entry]) => ({
                    categoryId,
                    label: CATEGORY_LABELS[categoryId] ?? `Unbekannte Kategorie ${categoryId}`,
                    count: entry.count,
                    // Only when most of what it covers rests on a settled verdict; otherwise the
                    // word "consistently" would be doing work one snapshot cannot support.
                    stable: entry.count > 0 && entry.stableSenders / entry.count >= 0.5,
                }))
                .sort((a, b) => b.count - a.count);
        },
        groups,
        analysis,
        suggestions,

        /** Folders whose name duplicates one of Proton's own — usually an IMAP migration leftover. */
        shadowFolders: folders.filter((folder) => folder.shadowsSystemFolder !== undefined),

        byId,
        outcomes,

        categories,

        caughtBy: (messageId) => {
            const outcome = outcomes.get(messageId);
            if (outcome?.decidedBy === undefined || outcome.destination === undefined) {
                return undefined;
            }
            return {
                ruleId: outcome.decidedBy.id,
                ruleName: outcome.decidedBy.name,
                destination: outcome.destination,
            };
        },

        /**
         * Every message of a group.
         *
         * `group.samples` holds five, which is why "17 Mails ansehen" showed five for as long as
         * anyone looked. The full membership is in `messageIds`; this resolves it and remembers
         * the answer, because a group's contents cannot change without a new mailbox.
         */
        messagesInGroup: (group) => {
            const cached = groupMembers.get(group.key);
            if (cached !== undefined) {
                return cached;
            }
            const resolved = group.messageIds
                .map((id) => byId.get(id))
                .filter((message): message is MailboxMessage => message !== undefined);
            groupMembers.set(group.key, resolved);
            return resolved;
        },

        analysisFor: (ruleId) => analysis.find((entry) => entry.ruleId === ruleId),

        /** The messages a rule catches, all of them. Callers paginate rather than truncate. */
        matchedBy: (ruleId, limit) => {
            const all = matchedByRule.get(ruleId) ?? [];
            return limit === undefined ? all : all.slice(0, limit);
        },

        destinationOf,

        messageCountIn: (folderName) => countsByFolder.get(folderName) ?? 0,

        /**
         * The Sieve a rule compiles to.
         *
         * Generated from the rule rather than stored, so what is shown is provably the same rule
         * the structural view above it renders. Storing a separate copy would let the two drift,
         * and the whole point of showing both is that they agree.
         */
        sieveTextFor: (ruleId) => {
            const entry = rules.find((candidate) => candidate.id === ruleId);
            return entry === undefined ? '' : JSON.stringify(toSieveTree(entry.rule, 2), null, 2);
        },

        /** Rules whose destination is this folder, including one nested beneath another. */
        rulesTargeting: (folderName) =>
            rules.filter((entry) =>
                entry.rule.Actions.FileInto.some(
                    (target) => target === folderName || target.endsWith(`/${folderName}`)
                )
            ),
    };
}

/** Proton's display order, with anything unrecognised after it rather than mixed in. */
function order(id: string): number {
    const index = (CATEGORY_IDS as readonly string[]).indexOf(id);
    return index === -1 ? CATEGORY_IDS.length : index;
}
