import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The page must not scroll sideways.
 *
 * This checks the stylesheet rather than a rendering, and that is a deliberate limitation worth
 * stating: it cannot prove the layout is right, only that the one mistake that produced the bug is
 * not back. That mistake is subtle enough to be worth a test of its own — a grid track sized `1fr`
 * still takes its *automatic* minimum from its content, so a single long subject line widened the
 * content column past the viewport and the whole window gained a horizontal scrollbar. `minmax(0,
 * 1fr)` is the form that actually permits a track to be narrower than what is in it.
 *
 * Reading the file is also the only way to catch this at all: the render tests use
 * `renderToStaticMarkup`, which has no layout, and nothing else in the suite has a viewport.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'src', 'app.css'), 'utf8');

/** Declarations, with their line number, so a failure names the place. */
function declarations(property: string): Array<{ line: number; text: string }> {
    return CSS.split('\n')
        .map((text, index) => ({ line: index + 1, text: text.trim() }))
        .filter((entry) => entry.text.startsWith(`${property}:`));
}

describe('flexible grid tracks', () => {
    it('are all written as minmax(0, …) so they may be narrower than their content', () => {
        const offenders = declarations('grid-template-columns').filter(
            (entry) => entry.text.includes('1fr') && !entry.text.includes('minmax(0')
        );

        expect(
            offenders.map((entry) => `app.css:${entry.line} — ${entry.text}`),
            'a bare 1fr track takes its minimum size from its content and widens the page'
        ).toEqual([]);
    });
});

describe('the layout', () => {
    it('lets the content column shrink', () => {
        // Without this the `1fr` track's own minimum still wins, whatever minmax says about it.
        expect(CSS).toMatch(/\.main\s*\{[^}]*min-width:\s*0/);
    });

    it('does not cap the content column, because the lists are the content', () => {
        // Long prose is capped where prose lives instead — see `.page-head p` and `.notice`.
        expect(CSS).not.toMatch(/\.main\s*\{[^}]*max-width:/);
    });

    it('fixes the diff table layout, which ignores width:100% when its content is wider', () => {
        expect(CSS).toMatch(/\.diff-table\s*\{[^}]*table-layout:\s*fixed/);
    });

    it('does not hide the symptom with overflow-x', () => {
        // Clipping would make the next occurrence invisible rather than absent. If this ever looks
        // like the fix, the cause has not been found yet.
        expect(CSS).not.toMatch(/overflow-x:\s*(hidden|clip)/);
    });
});
