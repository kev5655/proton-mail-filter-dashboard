import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from '../src/App.js';
import { FoldersPage } from '../src/pages/FoldersPage.js';
import { RulesPage } from '../src/pages/RulesPage.js';
import { TriagePage } from '../src/pages/TriagePage.js';

/**
 * A smoke test for each screen.
 *
 * Modest on purpose: it renders the pages and checks that the few things they exist to communicate
 * actually appear. The value is that the whole engine runs behind them — a page that renders here
 * is a page whose matcher, grouping and conflict analysis all completed against a full mailbox.
 * A crash in any of them would otherwise only show up as a blank screen in a browser.
 */

function render(element: React.JSX.Element): string {
    return renderToStaticMarkup(element);
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

    it('marks a Sieve-authored rule as such', () => {
        expect(text(html)).toContain('Sieve');
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

    it('shows which rules point at a folder, so deleting one is an informed decision', () => {
        expect(text(html)).toMatch(/\d+ Regel/);
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
