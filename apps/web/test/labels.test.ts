import { DEMO_FOLDERS, DEMO_LABELS, DEMO_RULES, generateMailbox } from '@pms/demo';
import { describe, expect, it } from 'vitest';

import { buildMailbox } from '../src/data.js';

/**
 * Labels, which are not folders, and the bug that came of pretending they were.
 *
 * Proton stores both as the same object with a different `Type`. The difference is what a rule does
 * with them — a folder *moves* the mail out of the inbox, a label *marks* it and leaves it there —
 * and the filter model has no separate action for it: the name goes into `FileInto` either way, and
 * Proton decides what it means by which object happens to carry it.
 *
 * The dashboard was discarding the label list entirely, which broke two things at once. A rule
 * pointing at a label was predicted to move mail that in fact stays put. And `categoryIdsOf` works
 * by elimination — a short numeric id that is neither a system location nor a known folder — so
 * every real label in a live account was being reported to the user as an unknown Proton category.
 */

const messages = generateMailbox();

function mailboxWith(labels: typeof DEMO_LABELS): ReturnType<typeof buildMailbox> {
    return buildMailbox({ messages, folders: DEMO_FOLDERS, labels, rules: DEMO_RULES });
}

describe('a label is not a category', () => {
    it('does not report the account’s own labels as unknown categories', () => {
        // A label id is short and numeric in a real account, which is exactly the shape
        // `categoryIdsOf` treats as a category unless it recognises it as something else.
        const numericLabel = [{ ID: '31', Name: 'Zu erledigen', ParentID: null }];
        const withLabel = buildMailbox({
            messages: messages.map((message) => ({ ...message, LabelIDs: [...message.LabelIDs, '31'] })),
            folders: DEMO_FOLDERS,
            labels: numericLabel,
            rules: DEMO_RULES,
        });

        expect(withLabel.categories.map((entry) => entry.id)).not.toContain('31');
    });

    it('would report it as one if the labels were dropped again', () => {
        // The failure, reproduced: the same mailbox without the label list. This is what every
        // account with labels was seeing.
        const withoutLabels = buildMailbox({
            messages: messages.map((message) => ({ ...message, LabelIDs: [...message.LabelIDs, '31'] })),
            folders: DEMO_FOLDERS,
            rules: DEMO_RULES,
        });

        expect(withoutLabels.categories.map((entry) => entry.id)).toContain('31');
    });
});

describe('a label is not a destination', () => {
    it('knows which names are labels', () => {
        const mailbox = mailboxWith(DEMO_LABELS);

        expect(mailbox.isLabelName('Zu erledigen')).toBe(true);
        expect(mailbox.isLabelName('Archiv')).toBe(false);
    });

    it('carries the labels through so a rule can offer them', () => {
        expect(mailboxWith(DEMO_LABELS).labels.map((label) => label.Name)).toContain('Steuerrelevant');
    });
});
