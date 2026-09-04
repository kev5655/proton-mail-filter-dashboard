import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SourceBanner } from '../src/App.js';
import type { MailboxStatus } from '../src/mailbox.js';

/**
 * The one thing on screen that must never be wrong.
 *
 * Everything else in the dashboard can be misleading and be corrected later. This line decides
 * whether someone reading a list of folder names believes it is theirs — and once it says the
 * mailbox is real, it also has to say how old the copy is and what is missing from it. A stale
 * screen is fine; a stale screen that presents itself as current is not.
 */

function text(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|[a-z]+);/g, ' ')
        .replace(/\s+/g, ' ');
}

function render(status: MailboxStatus & { loading: boolean }): string {
    return text(renderToStaticMarkup(<SourceBanner status={status} />));
}

const DEMO = {
    source: 'demo',
    syncedAt: undefined,
    version: undefined,
    truncated: false,
    unreadable: [],
    problem: undefined,
    history: [],
    historyLimit: undefined,
    loading: false,
} satisfies MailboxStatus & { loading: boolean };

const REAL = {
    source: 'proton',
    syncedAt: 1_700_000_000,
    version: 'v1',
    truncated: false,
    unreadable: [],
    problem: undefined,
    history: [],
    historyLimit: undefined,
    loading: false,
} satisfies MailboxStatus & { loading: boolean };

describe('on demo data', () => {
    it('says the mail is invented', () => {
        expect(render(DEMO)).toContain('Demo-Daten');
        expect(render(DEMO)).toContain('erfunden');
    });

    it('does not claim a real mailbox anywhere', () => {
        expect(render(DEMO)).not.toContain('Echtes Postfach');
    });

    it('reports a server that answered badly, and stays silent about one that is simply absent', () => {
        // No server running is the ordinary case — nobody has to start one to look at the demo.
        // A server that answered with something unusable is a different thing and has to surface.
        expect(render(DEMO)).not.toContain('unbrauchbar');
        expect(render({ ...DEMO, problem: 'Der Server antwortete mit 500.' })).toContain('unbrauchbar');
    });
});

describe('on the real mailbox', () => {
    it('names it as real and states that nothing is written', () => {
        const html = render(REAL);

        expect(html).toContain('Echtes Postfach');
        expect(html).toContain('keine Mails verschoben');
    });

    it('always shows how old the copy is', () => {
        // The dashboard reads a mirror, never the account. Without the date it would look live.
        expect(render(REAL)).toMatch(/Stand: \d/);
    });

    it('admits to not knowing the age rather than leaving it out', () => {
        expect(render({ ...REAL, syncedAt: undefined })).toContain('Stand: unbekannt');
    });

    it('says when the copy is incomplete', () => {
        expect(render({ ...REAL, truncated: true })).toContain('unvollständig');
    });

    it('names filters it could not read, because they still run at Proton', () => {
        // The dangerous omission: a filter missing from this list is a filter missing from every
        // conflict analysis, and the resulting picture is wrong in the reassuring direction.
        const html = render({
            ...REAL,
            unreadable: [{ id: 'r-9', name: 'Alte Sieve-Regel', reason: 'nicht übersetzbar' }],
        });

        expect(html).toContain('nicht lesbar');
        expect(html).toContain('Alte Sieve-Regel');
        expect(html).toContain('laufen bei Proton weiter');
    });
});
