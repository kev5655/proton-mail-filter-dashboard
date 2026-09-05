/**
 * A synthetic mailbox, for developing the interface without touching a real account.
 *
 * Shaped after a real one — roughly fifteen folders with a single level of nesting, one hand-written
 * Sieve filter, and five to ten messages a day — because a demo built on a tidy, evenly-sized
 * mailbox makes every screen look good and teaches you nothing. The interesting cases are the ones
 * that show up here on purpose: a sender whose mail splits into two unrelated kinds, folders left
 * over from an IMAP migration that shadow Proton's own, a rule that never fires, and a long tail of
 * one-off mail that should stay ungrouped.
 *
 * Deterministic: the same seed produces the same mailbox every time, so a screenshot taken today
 * matches the one taken tomorrow and a failing test can be reproduced.
 */

export interface DemoMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string; Name: string };
    ToList: Array<{ Address: string }>;
    Time: number;
    LabelIDs: string[];
    Unread: number;
    NumAttachments: number;
}

export interface DemoFolder {
    ID: string;
    Name: string;
    ParentID: string | null;
    /** Set when the folder duplicates one of Proton's own — an IMAP migration leftover. */
    shadowsSystemFolder?: string;
}

export interface DemoFilter {
    ID: string;
    Name: string;
    Status: number;
    Priority: number;
    /** Sieve-authored filters have no Simple field, exactly as the real API returns them. */
    authoredAs: 'tree' | 'sieve';
}

/** A small deterministic generator; the exact distribution matters less than its stability. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

export const INBOX = '0';
export const ARCHIVE = '6';

const CATEGORY = { newsletters: '25', promotions: '21', transactions: '26', updates: '22' } as const;

export const DEMO_FOLDERS: DemoFolder[] = [
    { ID: 'f-lohn', Name: 'Lohn', ParentID: null },
    { ID: 'f-mieten', Name: 'Mieten', ParentID: null },
    { ID: 'f-kosten', Name: 'Kosten Bestellung', ParentID: null },
    { ID: 'f-bahn', Name: 'Bahn', ParentID: 'f-kosten' },
    { ID: 'f-newsletter', Name: 'Newsletter', ParentID: null },
    { ID: 'f-security', Name: 'Security-Meldung', ParentID: null },
    { ID: 'f-archiv', Name: 'Archiv', ParentID: null },
    { ID: 'f-reisen', Name: 'Reisen', ParentID: null },
    { ID: 'f-wichtig', Name: 'Wichtig', ParentID: null },
    { ID: 'f-notizen', Name: 'Notizen-Import', ParentID: null },
    // The migration leftovers. Proton already has Trash, Spam and Sent; these duplicate them, and
    // any rule pointing at one of them files mail somewhere the user never looks.
    { ID: 'f-deleted-items', Name: 'Deleted Items', ParentID: null, shadowsSystemFolder: 'Papierkorb' },
    { ID: 'f-deleted-messages', Name: 'Deleted Messages', ParentID: null, shadowsSystemFolder: 'Papierkorb' },
    { ID: 'f-junk', Name: 'Junk', ParentID: null, shadowsSystemFolder: 'Spam' },
    { ID: 'f-sent', Name: 'Sent Messages', ParentID: null, shadowsSystemFolder: 'Gesendet' },
];

/**
 * The account's own labels, which are not folders.
 *
 * Proton stores both as the same object with a different `Type`, and the difference is what a rule
 * does with them: a folder *moves* the mail out of the inbox, a label *marks* it and leaves it
 * there. The demo had none, so nothing exercised that distinction — and the dashboard was quietly
 * reporting every real label in a live account as an unknown Proton category, because a label id
 * looks like one by elimination.
 *
 * „Wichtig" deliberately shares its name with a folder above. Proton allows it, and it is the case
 * where guessing what a rule's destination means goes wrong in the most confusing direction.
 */
export const DEMO_LABELS: DemoFolder[] = [
    { ID: 'l-zutun', Name: 'Zu erledigen', ParentID: null },
    { ID: 'l-steuer', Name: 'Steuerrelevant', ParentID: null },
    { ID: 'l-wichtig', Name: 'Wichtig', ParentID: null },
];

interface SenderProfile {
    address: string;
    name: string;
    subjects: string[];
    perWeek: number;
    unreadChance: number;
    /** Where its mail already sits; undefined means it is still in the inbox. */
    filedInto?: string;
    categories?: string[];
    attachments?: boolean;
}

/**
 * The senders that make the screens worth looking at.
 *
 * `accounts.example-cloud.com` is the important one: it sends both security alerts and product
 * announcements from the same address, so a sender-wide rule would sweep up both. That case is the
 * reason the grouping splits by subject at all.
 */
const SENDERS: SenderProfile[] = [
    {
        address: 'no-reply@accounts.example-cloud.com',
        name: 'Example Cloud',
        subjects: [
            'Neue Anmeldung bei deinem Konto',
            'Neue Anmeldung bei deinem Konto',
            'Neue Anmeldung bei deinem Konto',
        ],
        perWeek: 3,
        unreadChance: 0.9,
        categories: [CATEGORY.updates],
    },
    {
        address: 'no-reply@accounts.example-cloud.com',
        name: 'Example Cloud',
        subjects: ['Neuigkeiten zu deinem Konto', 'Neuigkeiten zu deinem Konto'],
        perWeek: 1,
        unreadChance: 0.95,
        categories: [CATEGORY.promotions],
    },
    {
        address: 'newsletter@versandhaus.example',
        name: 'Versandhaus',
        subjects: ['Angebot der Woche: {n}% auf alles', 'Nur heute: {n}% Rabatt'],
        perWeek: 4,
        unreadChance: 0.97,
        categories: [CATEGORY.promotions, CATEGORY.newsletters],
    },
    {
        address: 'rechnung@krankenkasse.example',
        name: 'Krankenkasse',
        subjects: ['Ihre Rechnung {n} über CHF {n}.{n}'],
        perWeek: 0.5,
        unreadChance: 0.3,
        attachments: true,
        categories: [CATEGORY.transactions],
    },
    {
        address: 'billing@bahn.example',
        name: 'Bahn',
        subjects: ['Ihr Ticket {n}', 'Buchungsbestätigung {n}'],
        perWeek: 1,
        unreadChance: 0.2,
        filedInto: 'f-bahn',
        categories: [CATEGORY.transactions],
    },
    {
        address: 'lohn@arbeitgeber.example',
        name: 'Personalabteilung',
        subjects: ['Lohnabrechnung {month}'],
        perWeek: 0.25,
        unreadChance: 0.1,
        filedInto: 'f-lohn',
        attachments: true,
    },
    // Several small senders at one organisation: individually too small for a rule, together not.
    { address: 'info@stadtwerke.example', name: 'Stadtwerke', subjects: ['Information zur Ablesung'], perWeek: 0.15, unreadChance: 0.6 },
    { address: 'service@stadtwerke.example', name: 'Stadtwerke Service', subjects: ['Ihre Anfrage {n}'], perWeek: 0.15, unreadChance: 0.6 },
    { address: 'abrechnung@stadtwerke.example', name: 'Stadtwerke Abrechnung', subjects: ['Jahresabrechnung {n}'], perWeek: 0.1, unreadChance: 0.5 },
];

/** One-off mail, so the triage screen has a realistic long tail that must stay ungrouped. */
const ONE_OFFS = [
    { address: 'anna@freunde.example', name: 'Anna', subject: 'Wochenende?' },
    { address: 'praxis@zahnarzt.example', name: 'Zahnarztpraxis', subject: 'Terminbestätigung' },
    { address: 'kontakt@verein.example', name: 'Verein', subject: 'Einladung zur Versammlung' },
    { address: 'support@werkzeug.example', name: 'Support', subject: 'Re: Ihre Anfrage' },
    { address: 'noreply@paket.example', name: 'Paketdienst', subject: 'Ihre Sendung ist unterwegs' },
];

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export interface MailboxOptions {
    seed?: number;
    /** How far back the mailbox reaches. */
    days?: number;
    /** Unix seconds for "now"; passed in so the data does not shift between runs. */
    now?: number;
}

const DAY = 24 * 60 * 60;

export function generateMailbox(options: MailboxOptions = {}): DemoMessage[] {
    const random = makeRandom(options.seed ?? 20260829);
    const days = options.days ?? 365;
    const now = options.now ?? 1_788_000_000;

    const messages: DemoMessage[] = [];
    let counter = 0;

    const fill = (template: string): string =>
        template
            .replace(/\{n\}/g, () => String(Math.floor(random() * 9000) + 100))
            .replace(/\{month\}/g, () => MONTHS[Math.floor(random() * 12)] as string);

    for (const sender of SENDERS) {
        const count = Math.max(1, Math.round((days / 7) * sender.perWeek));
        for (let index = 0; index < count; index++) {
            const daysAgo = Math.floor((index / count) * days + random() * 2);
            counter++;
            messages.push({
                ID: `demo-${counter}`,
                Subject: fill(sender.subjects[index % sender.subjects.length] as string),
                Sender: { Address: sender.address, Name: sender.name },
                ToList: [{ Address: 'kevin@example.me' }],
                Time: now - daysAgo * DAY,
                LabelIDs: [sender.filedInto ?? INBOX, ...(sender.categories ?? [])],
                Unread: random() < sender.unreadChance ? 1 : 0,
                NumAttachments: sender.attachments === true ? 1 : 0,
            });
        }
    }

    ONE_OFFS.forEach((entry, index) => {
        counter++;
        messages.push({
            ID: `demo-${counter}`,
            Subject: entry.subject,
            Sender: { Address: entry.address, Name: entry.name },
            ToList: [{ Address: 'kevin@example.me' }],
            Time: now - Math.floor(random() * days) * DAY,
            LabelIDs: [index % 2 === 0 ? INBOX : ARCHIVE],
            Unread: index % 3 === 0 ? 1 : 0,
            NumAttachments: 0,
        });
    });

    return messages.sort((a, b) => b.Time - a.Time);
}
