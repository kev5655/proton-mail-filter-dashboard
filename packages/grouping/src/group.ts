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
 * Proton's category labels — the tabs their own mailbox shows above the inbox.
 *
 * **Verified**, which they were not before. The ids come from `MAILBOX_LABEL_IDS` in Proton's own
 * `@proton/shared`, which ships minified inside the desktop client:
 *
 * ```
 * $ strings /usr/lib/proton-mail/resources/app.asar | grep -o 'CATEGORY_[A-Z]*="[0-9]*"'
 * ```
 *
 * Read from proton-mail 1.13.3 (Debian package, binary dated 2026-06-11) on 2026-09-04. Recording
 * the version matters more than recording the values: it is what makes a future divergence
 * something anyone can check rather than argue about.
 *
 * Two things that look like mistakes and are not:
 *
 *  - **There is no 23.** The sequence has a hole. Anybody "completing" it would be inventing a
 *    category Proton does not have.
 *  - **A category is not a label type.** `LABEL_TYPE` runs 1, 2, 3, 4 and none of them means
 *    category; these are fixed system label ids that ride along in a message's `LabelIDs` exactly
 *    like the inbox or the archive. There is nothing to fetch — reading them costs no endpoint.
 *
 * Anything consuming this map still has to cope with an id it does not know rather than dropping
 * the message: Proton can add a category tomorrow, and the mailbox is the only evidence we would
 * get.
 */
export const CATEGORY_LABELS: Record<string, string> = {
    '20': 'Soziale Medien',
    '21': 'Werbung',
    '22': 'Aktualisierungen',
    '24': 'Standard',
    '25': 'Newsletter',
    '26': 'Transaktionen',
};

/**
 * Proton's own order, from the `MAIL_CATEGORIES` array next to the ids in the same bundle.
 *
 * Kept separately from `CATEGORY_IDS` because the two are different claims. This one is a fact
 * about Proton; the other is our display choice. Collapsing them would make a future refresh look
 * like a bug in our layout.
 */
export const PROTON_CATEGORY_ORDER = ['24', '20', '21', '25', '26', '22'] as const;

/** Our display order: the ones a person acts on first, then the rest. */
export const CATEGORY_IDS = ['24', '25', '21', '26', '22', '20'] as const;

/**
 * Proton's system *locations*, which look like category ids and are not.
 *
 * Every message carries several — inbox, all mail, sent — and they have nothing to do with the
 * category tabs. They live here, beside the map they must stay disjoint from, because the previous
 * arrangement had this list in `apps/web` and the category map in this package: two lists in two
 * packages that had to agree, and did not. `16` (snoozed) and `40` (soft-deleted) were missing from
 * the copy, so a snoozed message was reported to the user as an unknown category.
 *
 * From the same bundle as `CATEGORY_LABELS`.
 */
export const SYSTEM_LOCATIONS: ReadonlySet<string> = new Set([
    '0', // inbox
    '1', // all drafts
    '2', // all sent
    '3', // trash
    '4', // spam
    '5', // all mail
    '6', // archive
    '7', // sent
    '8', // drafts
    '9', // outbox
    '10', // starred
    '12', // scheduled
    '15', // almost all mail
    '16', // snoozed
    '40', // soft deleted
]);

/**
 * The category ids on a message, by the one definition the whole project uses.
 *
 * Extracted so the sync engine and the dashboard cannot disagree about what a category is. They ask
 * the same question at different moments — the mirror while writing history, the dashboard while
 * rendering it — and a second implementation would eventually answer differently.
 *
 * An id we do not recognise is kept when it is shaped like a category and is neither a system
 * location nor one of this account's own folders. Reporting it as unknown is the only way the map
 * above ever gets corrected; silently dropping it would make Proton's next category invisible.
 */
export function categoryIdsOf(
    labelIds: readonly string[],
    knownFolderIds: ReadonlySet<string>
): string[] {
    return labelIds.filter((labelId) => {
        if (labelId in CATEGORY_LABELS) {
            return true;
        }
        return /^\d{1,2}$/.test(labelId) && !SYSTEM_LOCATIONS.has(labelId) && !knownFolderIds.has(labelId);
    });
}

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
