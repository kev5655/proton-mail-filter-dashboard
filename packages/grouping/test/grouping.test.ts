import { describe, expect, it } from 'vitest';

import { groupMessages, INBOX_LABEL, type GroupableMessage } from '../src/group.js';
import { registrableDomain, stripReplyPrefixes, subjectTemplate } from '../src/normalize.js';
import { explainScore, scoreGroups } from '../src/score.js';

/**
 * Grouping decides what the user is offered, and the ordering decides what they actually see.
 * Everything below the fold on the triage screen effectively does not exist, so these tests care
 * about two things: that a group's boundary is one a rule can express, and that the ordering puts
 * the genuinely annoying mail first.
 */

const DAY = 24 * 60 * 60;
const BASE = 1_780_000_000;

let counter = 0;
function mail(
    sender: string,
    subject: string,
    options: { daysAgo?: number; unread?: boolean; inbox?: boolean; labels?: string[] } = {}
): GroupableMessage {
    counter++;
    return {
        ID: `m${counter}`,
        Subject: subject,
        Sender: { Address: sender },
        Time: BASE - (options.daysAgo ?? 0) * DAY,
        LabelIDs: [...(options.inbox === false ? [] : [INBOX_LABEL]), ...(options.labels ?? [])],
        Unread: options.unread === true ? 1 : 0,
    };
}

function repeat(count: number, make: (index: number) => GroupableMessage): GroupableMessage[] {
    return Array.from({ length: count }, (_, index) => make(index));
}

describe('subject templates', () => {
    it('masks the part that changes every time', () => {
        // "2024-8891" is not a date — 8891 is no month-day — so it masks as two plain numbers.
        // Which is right: what matters is that the varying part is gone, not what it is called.
        expect(subjectTemplate('Ihre Rechnung 2024-8891 über CHF 42.10')).toBe(
            'Ihre Rechnung {n}-{n} über {amount}'
        );
    });

    it('recognises a real date as a date', () => {
        expect(subjectTemplate('Termin am 2024-08-29 um 14:05')).toBe('Termin am {date} um {time}');
    });

    it('collapses invoices with different numbers into one template', () => {
        expect(subjectTemplate('Rechnung Nr. 40182')).toBe(subjectTemplate('Rechnung Nr. 55913'));
    });

    it('keeps genuinely different subjects apart', () => {
        // Over-masking is the real risk: these two are not the same kind of mail.
        expect(subjectTemplate('Anmeldung von Chrome')).not.toBe(subjectTemplate('Anmeldung von Firefox'));
    });

    it('strips stacked reply and forward prefixes', () => {
        expect(stripReplyPrefixes('Re: AW: Fwd: Angebot')).toBe('Angebot');
        expect(stripReplyPrefixes('RE[2]: Angebot')).toBe('Angebot');
    });

    it('refuses a template that is only placeholders', () => {
        // "{n}" as a template would group every numeric subject together, which is nonsense.
        expect(subjectTemplate('4711')).toBe('');
        expect(subjectTemplate('2024-08-29 14:05')).toBe('');
    });
});

describe('registrable domain', () => {
    it('folds subdomains into the organisation', () => {
        expect(registrableDomain('accounts.google.com')).toBe('google.com');
        expect(registrableDomain('mail.notifications.example.org')).toBe('example.org');
    });

    it('handles two-label suffixes', () => {
        expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    });

    it('leaves a plain domain alone', () => {
        expect(registrableDomain('proton.me')).toBe('proton.me');
    });
});

describe('grouping', () => {
    it('groups by exact sender', () => {
        const groups = groupMessages(repeat(6, (i) => mail('no-reply@accounts.google.com', `Hinweis ${i}`)));

        expect(groups).toHaveLength(1);
        expect(groups[0]?.kind).toBe('sender');
        expect(groups[0]?.size).toBe(6);
        expect(groups[0]?.reason).toContain('no-reply@accounts.google.com');
    });

    it('splits one sender into its distinct kinds of mail', () => {
        // The case this project started from: security alerts and product news share an address,
        // and only one of them belongs in a folder.
        const messages = [
            ...repeat(5, () => mail('no-reply@accounts.google.com', 'Neue Anmeldung bei deinem Konto')),
            ...repeat(4, () => mail('no-reply@accounts.google.com', 'Neuigkeiten zu deinem Konto')),
        ];
        const groups = groupMessages(messages);

        expect(groups).toHaveLength(2);
        expect(groups.every((group) => group.kind === 'sender-subject')).toBe(true);
        expect(groups.map((group) => group.size).sort()).toEqual([4, 5]);
    });

    it('does not split when the subjects are ragged', () => {
        // A rule per subject variant is worse than one rule for the sender.
        const groups = groupMessages(repeat(8, (i) => mail('info@example.com', `Thema ${String.fromCharCode(97 + i)}`)));

        expect(groups).toHaveLength(1);
        expect(groups[0]?.kind).toBe('sender');
    });

    it('falls back to the organisation for senders too small on their own', () => {
        const messages = [
            mail('a@notifications.example.com', 'Eins'),
            mail('b@mail.example.com', 'Zwei'),
            mail('c@example.com', 'Drei'),
        ];
        const groups = groupMessages(messages);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.kind).toBe('domain');
        expect(groups[0]?.match.domain).toBe('example.com');
    });

    it('leaves genuinely one-off mail ungrouped', () => {
        const groups = groupMessages([
            mail('someone@personal.example', 'Hallo'),
            mail('other@another.example', 'Frage'),
        ]);

        expect(groups).toEqual([]);
    });

    it("picks up Proton's own category labels", () => {
        const groups = groupMessages(repeat(4, () => mail('news@shop.example', 'Angebot', { labels: ['21'] })));
        expect(groups[0]?.categories).toEqual(['Werbung']);
    });

    it('counts what is still in the inbox separately from the total', () => {
        const messages = [
            ...repeat(3, () => mail('n@example.com', 'Newsletter')),
            ...repeat(2, () => mail('n@example.com', 'Newsletter', { inbox: false })),
        ];
        const groups = groupMessages(messages);

        expect(groups[0]?.size).toBe(5);
        expect(groups[0]?.inboxCount).toBe(3);
    });

    it('gives every group a stable key, so a dismissal survives a re-index', () => {
        const messages = repeat(4, () => mail('n@example.com', 'Newsletter'));
        const first = groupMessages(messages).map((group) => group.key);
        const second = groupMessages([...messages].reverse()).map((group) => group.key);

        expect(first).toEqual(second);
    });
});

describe('ranking', () => {
    it('puts unread inbox clutter above mail that is already filed and read', () => {
        const noisy = repeat(20, (i) =>
            mail('newsletter@shop.example', 'Angebot der Woche', { unread: true, daysAgo: i * 7 })
        );
        const harmless = repeat(20, (i) =>
            mail('quiet@example.org', 'Bericht', { inbox: false, daysAgo: i * 7 })
        );

        const ranked = scoreGroups(groupMessages([...harmless, ...noisy]));

        expect(ranked[0]?.match.sender).toBe('newsletter@shop.example');
        expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 1);
    });

    it('does not let sheer volume drown the other signals', () => {
        // 200 already-filed mails must not outrank 12 unread ones sitting in the inbox.
        const huge = repeat(200, (i) => mail('bulk@example.com', 'Meldung', { inbox: false, daysAgo: i }));
        const small = repeat(12, (i) =>
            mail('annoying@example.net', 'Erinnerung', { unread: true, daysAgo: i * 7 })
        );

        const ranked = scoreGroups(groupMessages([...huge, ...small]));
        expect(ranked[0]?.match.sender).toBe('annoying@example.net');
    });

    it('scores a one-off burst below something that keeps arriving', () => {
        const burst = repeat(8, () => mail('burst@example.com', 'Aktion', { unread: true }));
        const steady = repeat(8, (i) => mail('steady@example.com', 'Wochenbericht', { unread: true, daysAgo: i * 7 }));

        const ranked = scoreGroups(groupMessages([...burst, ...steady]));
        expect(ranked[0]?.match.sender).toBe('steady@example.com');
    });

    it('sorts deterministically when scores tie', () => {
        const messages = [
            ...repeat(4, () => mail('a@example.com', 'Eins')),
            ...repeat(4, () => mail('b@example.com', 'Zwei')),
        ];
        const first = scoreGroups(groupMessages(messages)).map((group) => group.key);
        const second = scoreGroups(groupMessages([...messages].reverse())).map((group) => group.key);

        expect(first).toEqual(second);
    });

    it('explains a ranking in words the user can check', () => {
        const ranked = scoreGroups(
            groupMessages(repeat(10, (i) => mail('n@example.com', 'Newsletter', { unread: true, daysAgo: i * 7 })))
        );

        const explanation = explainScore(ranked[0] as never);
        expect(explanation).toContain('10 Mails');
        expect(explanation).toMatch(/Posteingang|geöffnet|regelmässig/);
    });
});
