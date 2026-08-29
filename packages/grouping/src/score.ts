import type { MessageGroup } from './group.js';

/**
 * How much a group is worth writing a rule for.
 *
 * The ordering this produces is the entire triage screen: whatever sits at the top is what the user
 * deals with, and everything below the fold effectively does not exist. So the score aims at one
 * question — how much noise does a rule here remove — rather than at anything cleverer.
 *
 * Four signals, all cheap and all explainable:
 *
 *   - **Volume.** Logarithmic, not linear. A group of 200 is not twenty times more worth automating
 *     than a group of 10; both are worth one rule, and linear volume would bury every other signal.
 *   - **Inbox residency.** Mail already filed somewhere is not the problem. A group still sitting in
 *     the inbox is exactly what the user asked to be rid of.
 *   - **Unread ratio.** Mail that arrives and is never opened is the clearest signal that it does
 *     not belong in the inbox — it is being ignored already, just manually.
 *   - **Recurrence.** Something arriving weekly for six months will keep arriving; a burst from one
 *     afternoon probably will not. A rule pays off on the former.
 *
 * Deliberately absent: anything about the content. Judging "importance" from a subject line is a
 * guess dressed as insight, and being wrong about it means hiding mail the user wanted.
 */

export interface ScoredGroup extends MessageGroup {
    score: number;
    /** The individual signals, so the UI can show why a group ranked where it did. */
    signals: {
        volume: number;
        inboxResidency: number;
        unreadRatio: number;
        recurrence: number;
    };
}

const WEIGHTS = { volume: 0.35, inboxResidency: 0.3, unreadRatio: 0.2, recurrence: 0.15 } as const;

const DAY_SECONDS = 24 * 60 * 60;

export function scoreGroup(group: MessageGroup): ScoredGroup {
    // log10 of the size, flattened so that 100 mails scores 1 and anything beyond stops helping.
    const volume = Math.min(1, Math.log10(group.size + 1) / 2);

    const inboxResidency = group.size === 0 ? 0 : group.inboxCount / group.size;
    const unreadRatio = group.size === 0 ? 0 : group.unreadCount / group.size;
    const recurrence = recurrenceOf(group);

    const score =
        WEIGHTS.volume * volume +
        WEIGHTS.inboxResidency * inboxResidency +
        WEIGHTS.unreadRatio * unreadRatio +
        WEIGHTS.recurrence * recurrence;

    return {
        ...group,
        score: Math.round(score * 1000) / 1000,
        signals: {
            volume: round(volume),
            inboxResidency: round(inboxResidency),
            unreadRatio: round(unreadRatio),
            recurrence: round(recurrence),
        },
    };
}

/**
 * How regularly the group arrives, as a rough 0..1.
 *
 * Measured as messages per week over the span they cover. A single message, or a group whose mail
 * all landed within a day, scores zero: there is nothing yet to suggest it will continue.
 */
function recurrenceOf(group: MessageGroup): number {
    const spanSeconds = group.lastSeen - group.firstSeen;
    if (group.size < 2 || spanSeconds < DAY_SECONDS) {
        return 0;
    }

    const weeks = spanSeconds / (7 * DAY_SECONDS);
    const perWeek = group.size / Math.max(weeks, 1 / 7);

    // One a week is already a solid rhythm; more than three adds nothing to the decision.
    return Math.min(1, perWeek / 3);
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

export function scoreGroups(groups: MessageGroup[]): ScoredGroup[] {
    return groups
        .map(scoreGroup)
        .sort((a, b) => b.score - a.score || b.size - a.size || a.key.localeCompare(b.key));
}

/** One sentence on why this group ranked where it did. */
export function explainScore(group: ScoredGroup): string {
    const parts: string[] = [];

    if (group.signals.inboxResidency >= 0.8) {
        parts.push('liegt noch komplett im Posteingang');
    } else if (group.signals.inboxResidency >= 0.4) {
        parts.push(`${group.inboxCount} davon noch im Posteingang`);
    }

    if (group.signals.unreadRatio >= 0.7) {
        parts.push('fast nie geöffnet');
    } else if (group.signals.unreadRatio >= 0.3) {
        parts.push(`${group.unreadCount} ungelesen`);
    }

    if (group.signals.recurrence >= 0.6) {
        parts.push('kommt regelmässig');
    }

    return parts.length === 0 ? group.reason : `${group.reason} — ${parts.join(', ')}`;
}
