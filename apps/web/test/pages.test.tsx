import { FilterStatement } from '@proton/sieve/filterModel';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Dashboard } from '../src/App.js';
import { FoldersPage } from '../src/pages/FoldersPage.js';
import { RulesPage } from '../src/pages/RulesPage.js';
import { TriagePage } from '../src/pages/TriagePage.js';
import { MailList } from '../src/components/MailList.js';
import { RuleConditions } from '../src/components/RuleConditions.js';
import { DEMO_RULES as rules } from '@pms/demo';
import { Providers } from './harness.js';
import { ChangesPage } from '../src/pages/ChangesPage.js';
import { HistoryPage } from '../src/pages/HistoryPage.js';
import { ActivityLog } from '../src/components/ActivityLog.js';
import { StoreProvider } from '../src/store.js';

/**
 * A smoke test for each screen.
 *
 * Modest on purpose: it renders the pages and checks that the few things they exist to communicate
 * actually appear. The value is that the whole engine runs behind them — a page that renders here
 * is a page whose matcher, grouping and conflict analysis all completed against a full mailbox.
 * A crash in any of them would otherwise only show up as a blank screen in a browser.
 */

/**
 * Pages read shared state — which mails are selected, where the user is, and the current rules and
 * folders — so they are rendered inside both providers, exactly as the app mounts them. Rendering
 * them bare would test a shape the application never uses.
 */
function render(element: React.JSX.Element): string {
    return renderToStaticMarkup(
<Providers withStore>{element}</Providers>
    );
}

function text(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|[a-z]+);/g, ' ')
        .replace(/\s+/g, ' ');
}

describe('the rules page', () => {
    const html = render(<RulesPage />);

    it('lists every rule', () => {
        expect(text(html)).toContain('Bahn-Tickets');
        expect(text(html)).toContain('Alles Übrige ins Archiv');
    });

    it('flags the rule that matches but never decides anything', () => {
        // The failure Proton's own filter list cannot show. If this disappears, the page has lost
        // the thing that justifies it.
        expect(text(html)).toContain('wirkungslos');
    });

    it('flags the rule that no longer matches anything', () => {
        expect(text(html)).toContain('trifft nichts');
    });

    it('warns when a rule files into a folder that shadows a Proton system folder', () => {
        expect(text(html)).toContain('Zielordner doppelt');
    });

    it('marks a rule nobody has taken responsibility for, and does not offer it for editing', () => {
        // It used to sit here indistinguishable from the rest and fully editable, while at the same
        // time asking to be adopted on „Änderungen" — so the same rule was both under management and
        // awaiting a decision about whether it should be. Editing it would have answered that
        // question by accident.
        const body = text(html);
        expect(body).toContain('nicht bestätigt');
        expect(body).toContain('sie läuft trotzdem');
        // Listed, not hidden: it is running at Proton right now, and a list of rules that leaves
        // out a running rule is worse than one that explains it.
        expect(body).toContain('Zahnarzt');
    });

    it('does not call a switched-off rule active', () => {
        // The badge used to be a verdict about how well a rule works, and its `default:` branch
        // said „aktiv" — including for a rule Proton is not running at all. Being confidently wrong
        // in green about somebody else's account is the worst version of this bug.
        const body = text(html);
        expect(body).toContain('Rechnungen ablegen (pausiert)');
        expect(body).toContain('deaktiviert');
    });

    it('distinguishes a script filter from a clickable Proton filter', () => {
        // The distinction decides what the user can do with the rule: a Proton filter can be edited
        // in their own interface, a script filter appears there only as code.
        const body = text(html);
        expect(body).toContain('Script-Filter');
        expect(body).toContain('Proton-Filter');
    });
});

describe('what a rule actually says', () => {
    // The rule detail opens on a click, so its parts are rendered directly rather than through the
    // page. What matters is the layout of a condition, not how it got on screen.
    const conditions = render(<RuleConditions rule={(rules[0] as (typeof rules)[number]).rule} />);

    it('renders a condition as field, comparison and values rather than one sentence', () => {
        // A condition with several values reads as one thing in prose and as several things it can
        // catch when laid out — which is what someone judging the rule needs to see.
        expect(conditions).toContain('condition-field');
        expect(conditions).toContain('value-chip');
        expect(text(conditions)).toContain('Absender');
    });

    it('always states where the mail ends up', () => {
        expect(text(conditions)).toContain('verschieben nach');
    });

    it('warns about a rule with no conditions, which catches everything', () => {
        const empty = render(
            <RuleConditions
                rule={{
                    Operator: { label: 'all', value: FilterStatement.ALL },
                    Conditions: [],
                    Actions: { FileInto: ['Archiv'], Mark: { Read: false, Starred: false } },
                }}
            />
        );
        expect(text(empty)).toContain('trifft jede Mail');
    });
});

describe('every list of mail', () => {
    const list = render(
        <MailList
            messages={[
                {
                    ID: 'x',
                    Subject: 'Testbetreff',
                    Sender: { Address: 'a@b.example' },
                    Time: 1_780_000_000,
                },
            ]}
            onOpen={() => undefined}
        />
    );

    it('lets a mail be opened', () => {
        expect(list).toContain('mail-open');
    });

    it('lets a mail be selected, so a rule can be built from a hand-picked set', () => {
        expect(list).toContain('mail-check');
        expect(list).toContain('type="checkbox"');
    });
});

describe('the triage page', () => {
    const html = render(<TriagePage />);

    it('proposes rules and says why each group exists', () => {
        expect(text(html)).toMatch(/Mails, alle von|Mails von/);
        expect(text(html)).toContain('nach');
    });

    it('separates the security alerts from the marketing mail of the same sender', () => {
        // The case the whole project started from: one sender, two kinds of mail, one folder.
        const body = text(html);
        expect(body).toContain('Neue Anmeldung bei deinem Konto');
        expect(body).toContain('Neuigkeiten zu deinem Konto');
    });

    it('offers nothing destructive without a click', () => {
        expect(text(html)).toContain('Regel anlegen');
        expect(text(html)).toContain('Nicht vorschlagen');
    });
});

describe('the folders page', () => {
    const html = render(<FoldersPage />);

    it('shows the tree including the nested folder', () => {
        expect(text(html)).toContain('Kosten Bestellung');
        expect(text(html)).toContain('Bahn');
    });

    it('calls out the folders left over from an IMAP migration', () => {
        expect(text(html)).toContain('doppeln Proton-Systemordner');
        expect(text(html)).toContain('Deleted Items');
    });

    it('names the rules that sort into a folder, so deleting one is an informed decision', () => {
        const body = text(html);
        expect(body).toContain('Regeln, die hierher sortieren');
        expect(body).toContain('Bahn-Tickets');
    });
});

describe('the shell', () => {
    // The dashboard, not `App`: `App` waits for the server's answer about whether anything is
    // locked, and a synchronous render never gets past that wait. The gate is checked in
    // `lock-screen.test.tsx`, which can await.
    const html = render(<Dashboard />);

    it('says on every screen that this is demo data', () => {
        // Someone looking at a plausible list of folder names must never wonder whether it is real.
        expect(text(html)).toContain('Demo-Daten');
        expect(text(html)).toContain('Kein Proton-Konto verbunden');
    });

    it('offers all three sections', () => {
        const body = text(html);
        expect(body).toContain('Regeln');
        expect(body).toContain('Vorschläge');
        expect(body).toContain('Ordner');
    });
});

describe('the history', () => {
    const html = render(<HistoryPage />);

    it('says what undo actually does, so it is not mistaken for a soft reset', () => {
        expect(text(html)).toContain('inklusive der Mails, die sie verschoben hat');
    });

    it('mentions the backup that sits underneath the journal', () => {
        expect(text(html)).toContain('Sicherung');
    });
});

describe('changes made in Proton itself', () => {
    const html = render(<ChangesPage />);

    it('lists what appeared without the tool doing it', () => {
        expect(text(html)).toContain('Zahnarzt');
        expect(text(html)).toContain('Steuern 2026');
    });

    it('offers disabling alongside deleting, and names both', () => {
        // Someone wrote that rule on purpose, so „ablehnen" must not silently mean „delete". Both
        // are offered and both say what they are; deleting additionally asks in the terminal, which
        // is `weigh`'s job rather than this screen's.
        expect(text(html)).toContain('Deaktivieren');
        expect(text(html)).toContain('Löschen');
    });

    it('says that adopting changes nothing at the account', () => {
        // The distinction the screen turns on: two of the three answers write, one does not.
        expect(text(html)).toContain('Übernehmen ändert nichts am Konto');
    });
});

describe('the log', () => {
    const html = render(<ActivityLog />);

    it('offers an export and says what it does not contain', () => {
        expect(text(html)).toContain('Bericht kopieren');
        expect(text(html)).toContain('keine Mailinhalte');
    });
});
