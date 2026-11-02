import { AppError } from '@pms/core/errors';

import type { Move } from './plan.js';
import type { VerificationResult } from './journal.js';

/**
 * Checking that Proton actually did what the rule promised.
 *
 * A write returning HTTP 200 means Proton accepted the filter, not that any mail moved. Between the
 * two sit `apply-filters`, Proton's own ordering, and whatever else already matched — so the only
 * honest confirmation is to look at the messages afterwards and see where they are.
 *
 * A partial result is the one that matters. "17 of 20 moved" is a real state that no error code
 * reports, and left unchecked it becomes three messages sitting in the inbox that the user believes
 * are filed. It is raised rather than logged.
 */

export interface MessageState {
    ID: string;
    LabelIDs: string[];
}

export interface VerifyInput {
    /** What the plan said would happen. */
    expected: Move[];
    /** Where the messages are now, read back from Proton after the write. */
    actual: MessageState[];
    /** Folder name to label id, since a plan speaks in names and Proton answers in ids. */
    folderIds: Map<string, string>;
    /** Unix **seconds**. The whole journal is in seconds; see `JournalEntry`. */
    nowSeconds: number;
}

export function verifyMoves({ expected, actual, folderIds, nowSeconds }: VerifyInput): VerificationResult {
    const byId = new Map(actual.map((message) => [message.ID, message]));
    const stragglers: string[] = [];
    let confirmed = 0;

    for (const move of expected) {
        if (move.to === undefined) {
            // The plan expected this message to end up in the inbox; nothing to confirm at Proton.
            continue;
        }

        const state = byId.get(move.messageId);
        if (state === undefined) {
            // Not returned by the read-back. Treated as unconfirmed rather than as fine: an absent
            // message is exactly as unproven as one in the wrong place.
            stragglers.push(move.messageId);
            continue;
        }

        const expectedLabel = folderIds.get(move.to);
        if (expectedLabel !== undefined && state.LabelIDs.includes(expectedLabel)) {
            confirmed++;
        } else {
            stragglers.push(move.messageId);
        }
    }

    return { confirmed, stragglers, checkedAtSeconds: nowSeconds };
}

/**
 * Turn an incomplete result into the error the user sees.
 *
 * Returns undefined when everything landed, so the caller can simply `throw` whatever comes back
 * and not have to remember the success case.
 */
export function partialMoveError(
    result: VerificationResult,
    ruleName: string
): AppError | undefined {
    if (result.stragglers.length === 0) {
        return undefined;
    }

    const total = result.confirmed + result.stragglers.length;
    return new AppError('VERIFY_PARTIAL_MOVE', {
        message: `„${ruleName}" wurde angelegt, aber nur ${result.confirmed} von ${total} Mails sind tatsächlich verschoben.`,
        hint:
            'Die übrigen liegen noch dort, wo sie waren. Das passiert, wenn Proton die Regel erst auf ' +
            'neue Mail anwendet — nochmal auf den Bestand anwenden hilft meist.',
        context: {
            ruleName,
            confirmed: result.confirmed,
            missing: result.stragglers.length,
            // Ids only. A subject line here would end up in a log file.
            stragglerIds: result.stragglers.slice(0, 20),
        },
    });
}

/**
 * The ongoing check: mail a rule should have caught that is still sitting in the inbox.
 *
 * This is the only way to notice that the local matcher and Proton have drifted apart. Everything
 * else in the project compares our simulation against itself; this compares it against the mailbox.
 * Until it has run against a real account, every preview in the interface is an estimate and is
 * labelled as one.
 */
export interface HealthFinding {
    ruleId: string;
    ruleName: string;
    /** Messages the matcher says this rule catches, still in the inbox. */
    missedMessageIds: string[];
}

export function findRulesNotFiring(
    rules: Array<{ id: string; name: string; catches: (message: MessageState) => boolean }>,
    inbox: MessageState[]
): HealthFinding[] {
    return rules
        .map((rule) => ({
            ruleId: rule.id,
            ruleName: rule.name,
            missedMessageIds: inbox.filter((message) => rule.catches(message)).map((message) => message.ID),
        }))
        .filter((finding) => finding.missedMessageIds.length > 0);
}
