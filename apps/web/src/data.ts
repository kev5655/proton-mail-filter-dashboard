import type { SimpleObject } from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';

import { INBOX } from '@pms/demo';
import type { MailboxFolder, MailboxMessage, MailboxRule } from '@pms/server/types';
import { groupMessages, scoreGroups, type ScoredGroup } from '@pms/grouping';
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
    rules: MailboxRule[];
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
    if (group.categories.includes('Newsletter') || group.categories.includes('Werbung')) {
        return 'Newsletter';
    }

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

        for (const entry of ordered) {
            if (!matchesRule(entry.rule, message)) {
                continue;
            }
            matching.push(entry);
            const target = entry.rule.Actions.FileInto.at(-1);
            if (target !== undefined && target !== '') {
                destination = target;
                decidedBy = { id: entry.id, name: entry.name };
            }
        }

        outcomes.set(message.ID, { destination, decidedBy, matching });
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

    return {
        messages,
        folders,
        rules,
        inboxMessages,
        groups,
        analysis,
        suggestions,

        /** Folders whose name duplicates one of Proton's own — usually an IMAP migration leftover. */
        shadowFolders: folders.filter((folder) => folder.shadowsSystemFolder !== undefined),

        byId,
        outcomes,

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
