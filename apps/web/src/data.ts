import type { SimpleObject } from '@proton/sieve/filterModel';
import { toSieveTree } from '@proton/sieve/toSieveTree';

import { DEMO_FOLDERS, DEMO_RULES, generateMailbox, INBOX, type DemoMessage, type DemoRule } from '@pms/demo';
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
 * Everything the interface shows, computed once from the demo mailbox.
 *
 * The point of wiring the real engine to fake mail rather than mocking the screens: what appears
 * here is genuinely what the matcher, the grouping and the conflict analysis produce. If a preview
 * looks wrong on screen, the bug is in the logic and not in a fixture someone typed to look nice.
 */

export const messages: DemoMessage[] = generateMailbox();
export const folders = DEMO_FOLDERS;
export const rules: DemoRule[] = DEMO_RULES;

export const inboxMessages = messages.filter((message) => message.LabelIDs.includes(INBOX));

/** Groups, ranked — the triage screen in data form. */
export const groups: ScoredGroup[] = scoreGroups(groupMessages(inboxMessages));

export const analysis: RuleAnalysis[] = analyseRules(rules, messages);

export function analysisFor(ruleId: string): RuleAnalysis | undefined {
    return analysis.find((entry) => entry.ruleId === ruleId);
}

/** The messages a rule catches, newest first. Capped: the list is for judging, not for browsing. */
export function matchedBy(ruleId: string, limit = 8): DemoMessage[] {
    const entry = rules.find((candidate) => candidate.id === ruleId);
    if (entry === undefined) {
        return [];
    }
    return messages.filter((message) => matchesRule(entry.rule, message)).slice(0, limit);
}

/**
 * Where a message actually ends up once every rule has run.
 *
 * Not the same as "which rules match": several can, and the last one to file it wins. Showing only
 * the matches would tell the user something true and useless.
 */
export function destinationOf(message: DemoMessage): string | undefined {
    return resolveOutcome(rules, message).destination;
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

export const suggestions: Suggestion[] = groups.map((group) => {
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

/** Folders whose name duplicates one of Proton's own — leftovers from an IMAP migration. */
export const shadowFolders = folders.filter((folder) => folder.shadowsSystemFolder !== undefined);

export function messageCountIn(folderName: string): number {
    return messages.filter((message) => destinationOf(message) === folderName).length;
}

/**
 * The Sieve a rule compiles to.
 *
 * Generated from the rule rather than stored, so what is shown is provably the same rule the
 * structural view above it renders. Storing a separate copy would let the two drift, and the whole
 * point of showing both is that they agree.
 */
export function sieveTextFor(ruleId: string): string {
    const entry = rules.find((candidate) => candidate.id === ruleId);
    if (entry === undefined) {
        return '';
    }
    return JSON.stringify(toSieveTree(entry.rule, 2), null, 2);
}

/** Rules whose destination is this folder, including one nested beneath another. */
export function rulesTargeting(folderName: string): DemoRule[] {
    return rules.filter((entry) =>
        entry.rule.Actions.FileInto.some(
            (target) => target === folderName || target.endsWith(`/${folderName}`)
        )
    );
}
