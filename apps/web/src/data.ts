import type { SimpleObject } from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';

import { INBOX } from '@pms/demo';
import type { MailboxFolder, MailboxMessage, MailboxRule } from '@pms/server/types';
import { groupMessages, scoreGroups, type ScoredGroup } from '@pms/grouping';
import {
    analyseRules,
    matchesRule,
    protonEscapingIsBroken,
    resolveOutcome,
    ruleFromGroup,
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

export interface MailboxData extends MailboxInput {
    inboxMessages: MailboxMessage[];
    groups: ScoredGroup[];
    analysis: RuleAnalysis[];
    suggestions: Suggestion[];
    shadowFolders: MailboxFolder[];
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

    /**
     * Where a message actually ends up once every rule has run.
     *
     * Not the same as "which rules match": several can, and the last one to file it wins. Showing
     * only the matches would tell the user something true and useless.
     */
    const destinationOf = (message: MailboxMessage): string | undefined =>
        resolveOutcome(rules, message).destination;

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

        analysisFor: (ruleId) => analysis.find((entry) => entry.ruleId === ruleId),

        /** The messages a rule catches. Capped: the list is for judging, not for browsing. */
        matchedBy: (ruleId, limit = 8) => {
            const entry = rules.find((candidate) => candidate.id === ruleId);
            return entry === undefined
                ? []
                : messages.filter((message) => matchesRule(entry.rule, message)).slice(0, limit);
        },

        destinationOf,

        messageCountIn: (folderName) =>
            messages.filter((message) => destinationOf(message) === folderName).length,

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
