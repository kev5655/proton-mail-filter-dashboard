import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Three places where things sat at the wrong distance from each other.
 *
 * Like `css-overflow.test.ts`, this reads the stylesheet rather than a rendering, and the same
 * limitation applies: it cannot prove the layout looks right, only that the specific mistake is not
 * back. That is worth having anyway, because none of these are visible to any other kind of test —
 * the render tests have no layout and nothing else in the suite has a viewport. What catches the
 * appearance is a person looking, and what keeps it from silently reverting is this.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, '..', 'src', 'app.css'), 'utf8');

/** One rule body, so an assertion is about the block it names and not about the whole file. */
function block(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
    expect(match, `no rule for ${selector} in app.css`).not.toBeNull();
    return match?.[1] ?? '';
}

describe('a heading row', () => {
    it('leaves a gap below itself', () => {
        // „Was geändert wurde" had a button at its right end and nothing underneath it, so the
        // first card of the list touched the heading and read as part of it.
        expect(block('.head-row')).toMatch(/margin-bottom:\s*\d/);
    });
});

describe('the actions on a card', () => {
    it('let the heading side take the remaining room', () => {
        // Both sides shrank together otherwise: a long title wrapped to two lines while the
        // buttons beside it wrapped one under the other.
        expect(block('.card-head > .stack')).toMatch(/flex:\s*1\b/);
    });

    it('stay against the right edge as one group', () => {
        const rule = block('.card-actions');
        expect(rule).toMatch(/justify-content:\s*flex-end/);
        // `flex: none` is what keeps the group from being squeezed into a column of its own width.
        expect(rule).toMatch(/flex:\s*none/);
    });
});

describe('a list of options', () => {
    it('gives every explanation the same starting column', () => {
        // As flex rows each explanation began where its own label ended, so „Aus" and „Anbieter
        // mit API-Schlüssel" pushed their text to two very different places.
        expect(block('.choice-grid')).toMatch(/display:\s*grid/);
        expect(block('.choice-grid')).toMatch(/grid-template-columns:/);
    });

    it('dissolves the rows into that grid, which is what makes the columns shared', () => {
        // Without `display: contents` each row is its own grid item and the columns mean nothing.
        expect(block('.choice-grid > .radio-row')).toMatch(/display:\s*contents/);
    });

    it('does not change `.radio-row`, which the rule editor uses on its own', () => {
        // A single row has nothing to line up with, so a shared column width there would only
        // impose one screen's proportions on another.
        expect(block('.radio-row')).toMatch(/display:\s*flex/);
    });
});
