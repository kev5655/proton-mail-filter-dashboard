import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SourceBanner } from '../src/App.js';
import type { MailboxStatus } from '../src/mailbox.js';

/**
 * The one thing on screen that must never be wrong.
 *
 * Everything else in the dashboard can be misleading and be corrected later. This line decides
 * whether someone reading a list of folder names believes it is theirs — and having said so, it
 * also has to say how old the copy is and what is missing from it. A stale screen is fine; a stale
 * screen that presents itself as current is not.
 *
 * There used to be a second half here, for the invented mailbox the dashboard fell back to. That
 * mailbox is gone, so the banner has one case and the tests below are all of it.
 */

function text(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|[a-z]+);/g, ' ')
        .replace(/\s+/g, ' ');
}

function render(status: MailboxStatus): string {
    return text(renderToStaticMarkup(<SourceBanner status={status} />));
}

const REAL = {
    syncedAt: 1_700_000_000,
    version: 'v1',
    truncated: false,
    unreadable: [],
    history: [],
    historyLimit: undefined,
    hiddenSuggestions: [],
} satisfies MailboxStatus;

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
