import {
    emailDomain,
    normalizeAddress,
    registrableDomain,
    subjectTemplate,
    subjectTemplateKey,
} from './normalize.js';

/**
 * Turning a pile of inbox mail into groups worth writing a rule for.
 *
 * The grouping is deterministic rather than learned, and that is the point: every group carries the
 * reason it exists ("47 mails, all from no-reply@accounts.google.com"), which is what makes the
 * suggestion reviewable and the resulting rule predictable. A cluster whose boundary nobody can
 * explain produces a filter whose behaviour nobody can predict.
 *
 * The keys were chosen to match what Proton's clickable filters can actually express — sender,
 * recipient, subject, attachments. Grouping by something a rule cannot encode would produce
 * suggestions that cannot be acted on.
 */

export interface GroupableMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string; Name?: string | undefined };
    Time: number;
    LabelIDs: string[];
    Unread: number;
}

export type GroupKind = 'sender' | 'sender-subject' | 'domain';

export interface MessageGroup {
    /** Stable identity, so a group survives a re-index and can be dismissed persistently. */
    key: string;
    kind: GroupKind;
    /** What the rule would match on. */
    match: {
        sender?: string;
        domain?: string;
        subjectTemplate?: string;
    };
    messageIds: string[];
    /** Up to five, newest first, for showing the user what is in the group. */
    samples: GroupableMessage[];
    size: number;
    unreadCount: number;
    /** How many are still sitting in the inbox — the ones a rule would actually clear out. */
    inboxCount: number;
    firstSeen: number;
    lastSeen: number;
    /** Proton's own category labels seen in this group, e.g. newsletters or transactions. */
    categories: string[];
    /** Human-readable justification, shown next to the suggestion. */
    reason: string;
}

export const INBOX_LABEL = '0';

/**
 * Proton's category labels, which arrive on every message and cost nothing to use.
 *
 * The names are Proton's own German ones, so a screen here and a screen there say the same thing.
 * The **ids are not verified** against a real account — they were written down from observation and
 * nothing in the vendored code or the fixtures confirms them. Anything reading this map has to cope
 * with an id it does not know rather than dropping the message, which is why `CATEGORY_IDS` exists
 * as the ordered list of what we claim to recognise: everything outside it is reported as unknown.
 */
export const CATEGORY_LABELS: Record<string, string> = {
    '20': 'Soziale Medien',
    '21': 'Werbung',
    '22': 'Aktualisierungen',
    '24': 'Standard',
    '25': 'Newsletter',
    '26': 'Transaktionen',
};

/** Display order, which is Proton's own rather than alphabetical. */
export const CATEGORY_IDS = ['24', '25', '21', '26', '22', '20'] as const;

export interface GroupingOptions {
    /** Below this, a sender is not worth its own rule and is folded into its domain. */
    minGroupSize?: number;
    /** A sender group only splits by subject when each part is at least this big. */
    minSplitSize?: number;
    /** Splitting into more parts than this is noise, not structure. */
    maxSplitParts?: number;
}

const DEFAULTS = { minGroupSize: 3, minSplitSize: 3, maxSplitParts: 6 } as const;

export function groupMessages(messages: GroupableMessage[], options: GroupingOptions = {}): MessageGroup[] {
    const settings = { ...DEFAULTS, ...options };

    const bySender = new Map<string, GroupableMessage[]>();
    for (const message of messages) {
        const sender = normalizeAddress(message.Sender.Address);
        if (sender === '') {
            continue;
        }
        const bucket = bySender.get(sender);
        if (bucket === undefined) {
            bySender.set(sender, [message]);
        } else {
            bucket.push(message);
        }
    }

    const groups: MessageGroup[] = [];
    const leftovers: GroupableMessage[] = [];

    for (const [sender, bucket] of bySender) {
        if (bucket.length < settings.minGroupSize) {
            // Too small to justify a rule on its own; maybe its domain adds up to something.
            leftovers.push(...bucket);
            continue;
        }
        groups.push(...splitBySubject(sender, bucket, settings));
    }

    groups.push(...groupLeftoversByDomain(leftovers, settings));
    return groups.sort((a, b) => b.size - a.size);
}

/**
 * Split one sender into distinct kinds of mail.
 *
 * This is the case the whole project started from: Google sends both security alerts and product
 * announcements from the same address, and only one of them belongs in a folder. A single
 * sender-wide rule would sweep up both.
 *
 * The split only happens when the subjects really do fall into a few stable shapes. Anything
 * ragged stays one group, because a rule per subject variant is worse than no rule at all.
 */
function splitBySubject(
    sender: string,
    messages: GroupableMessage[],
    settings: Required<GroupingOptions>
): MessageGroup[] {
    const byTemplate = new Map<string, GroupableMessage[]>();
    for (const message of messages) {
        const key = subjectTemplateKey(message.Subject);
        if (key === '') {
            // No usable template — this message cannot take part in a split.
            return [buildGroup('sender', { sender }, messages)];
        }
        const bucket = byTemplate.get(key);
        if (bucket === undefined) {
            byTemplate.set(key, [message]);
        } else {
            bucket.push(message);
        }
    }

    const parts = [...byTemplate.values()];
    const splitIsClean =
        parts.length >= 2 &&
        parts.length <= settings.maxSplitParts &&
        parts.every((part) => part.length >= settings.minSplitSize);

    if (!splitIsClean) {
        return [buildGroup('sender', { sender }, messages)];
    }

    return parts.map((part) =>
        buildGroup(
            'sender-subject',
            { sender, subjectTemplate: subjectTemplate((part[0] as GroupableMessage).Subject) },
            part
        )
    );
}

/** Senders too small on their own can still add up per organisation. */
function groupLeftoversByDomain(
    messages: GroupableMessage[],
    settings: Required<GroupingOptions>
): MessageGroup[] {
    const byDomain = new Map<string, GroupableMessage[]>();
    for (const message of messages) {
        const domain = registrableDomain(emailDomain(message.Sender.Address));
        if (domain === '') {
            continue;
        }
        const bucket = byDomain.get(domain);
        if (bucket === undefined) {
            byDomain.set(domain, [message]);
        } else {
            bucket.push(message);
        }
    }

    return [...byDomain.entries()]
        .filter(([, bucket]) => bucket.length >= settings.minGroupSize)
        .map(([domain, bucket]) => buildGroup('domain', { domain }, bucket));
}

function buildGroup(
    kind: GroupKind,
    match: MessageGroup['match'],
    messages: GroupableMessage[]
): MessageGroup {
    const sorted = [...messages].sort((a, b) => b.Time - a.Time);
    const times = sorted.map((message) => message.Time);
    const categories = [
        ...new Set(
            sorted.flatMap((message) =>
                message.LabelIDs.map((id) => CATEGORY_LABELS[id]).filter(
                    (label): label is string => label !== undefined
                )
            )
        ),
    ];

    const group: MessageGroup = {
        key: groupKey(kind, match),
        kind,
        match,
        messageIds: sorted.map((message) => message.ID),
        samples: sorted.slice(0, 5),
        size: sorted.length,
        unreadCount: sorted.filter((message) => message.Unread === 1).length,
        inboxCount: sorted.filter((message) => message.LabelIDs.includes(INBOX_LABEL)).length,
        firstSeen: Math.min(...times),
        lastSeen: Math.max(...times),
        categories,
        reason: '',
    };

    group.reason = describe(group);
    return group;
}

function groupKey(kind: GroupKind, match: MessageGroup['match']): string {
    switch (kind) {
        case 'sender':
            return `sender:${match.sender ?? ''}`;
        case 'sender-subject':
            return `sender-subject:${match.sender ?? ''}:${(match.subjectTemplate ?? '').toLowerCase()}`;
        case 'domain':
            return `domain:${match.domain ?? ''}`;
        default:
            return 'unknown';
    }
}

/**
 * Why this group exists, in one sentence.
 *
 * Shown next to every suggestion. A group the user cannot see the logic of is a rule they cannot
 * judge, and the whole design rests on them judging it.
 */
function describe(group: MessageGroup): string {
    const count = `${group.size} ${group.size === 1 ? 'Mail' : 'Mails'}`;

    switch (group.kind) {
        case 'sender':
            return `${count}, alle von ${group.match.sender}`;
        case 'sender-subject':
            return `${count} von ${group.match.sender} mit Betreff „${group.match.subjectTemplate}"`;
        case 'domain':
            return `${count} von verschiedenen Absendern bei ${group.match.domain}`;
        default:
            return count;
    }
}
