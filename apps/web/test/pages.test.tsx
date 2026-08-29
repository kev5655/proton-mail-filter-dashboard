import { FilterStatement } from '@proton/sieve/filterModel';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App.js';
import { FoldersPage } from '../src/pages/FoldersPage.js';
import { RulesPage } from '../src/pages/RulesPage.js';
import { TriagePage } from '../src/pages/TriagePage.js';
import { MailList } from '../src/components/MailList.js';
import { RuleConditions } from '../src/components/RuleConditions.js';
import { rules } from '../src/data.js';
import { AppStateProvider } from '../src/state.js';
import { ChangesPage } from '../src/pages/ChangesPage.js';
import { HistoryPage } from '../src/pages/HistoryPage.js';
import { LogPage } from '../src/pages/LogPage.js';
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
        <AppStateProvider>
            <StoreProvider>{element}</StoreProvider>
        </AppStateProvider>
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
    const html = render(<App />);

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

    it('rejects by disabling, not deleting', () => {
        // Someone wrote that rule on purpose. Losing it to a misclick in a review screen would be a
        // poor trade for tidiness.
        expect(text(html)).toContain('Ablehnen (deaktivieren)');
        expect(text(html)).toContain('zweite, ausdrückliche Entscheidung');
    });
});

describe('the log', () => {
    const html = render(<LogPage />);

    it('offers an export and says what it does not contain', () => {
        expect(text(html)).toContain('Bericht kopieren');
        expect(text(html)).toContain('keine Mailinhalte');
    });
});
