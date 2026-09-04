import { describe, expect, it } from 'vitest';

import {
    categoryIdsOf,
    CATEGORY_IDS,
    CATEGORY_LABELS,
    PROTON_CATEGORY_ORDER,
    SYSTEM_LOCATIONS,
} from '../src/group.js';

/**
 * The category map, pinned.
 *
 * These ids are the one thing in this project taken from Proton's own code rather than from a
 * response we can validate: they were read out of `MAILBOX_LABEL_IDS` in the minified
 * `@proton/shared` inside the desktop client. That makes them correct today and unguarded
 * tomorrow — nothing at runtime would notice a typo, because an id nobody uses is simply an id
 * nobody uses. So the invariants are asserted here instead.
 *
 * The one that matters most is the hole at 23. A sequence 20, 21, 22, 24, 25, 26 looks like a
 * mistake and is not, and someone tidying it up would invent a category Proton does not have.
 */

const NO_FOLDERS: ReadonlySet<string> = new Set();

describe('the category map', () => {
    it('lists exactly the ids it claims to display', () => {
        // Two hand-written lists that must agree. They drifted apart once already, in the copy of
        // SYSTEM_LOCATIONS that used to live in apps/web.
        expect([...CATEGORY_IDS].sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
    });

    it("orders the same ids as Proton's own order, differently", () => {
        expect([...PROTON_CATEGORY_ORDER].sort()).toEqual([...CATEGORY_IDS].sort());
        // Kept apart on purpose: one is a fact about Proton, the other is our display choice. If
        // they ever became identical the distinction would still be worth keeping.
        expect([...PROTON_CATEGORY_ORDER]).not.toEqual([...CATEGORY_IDS]);
    });

    it('has no id 23 — the gap is real, not an omission', () => {
        expect(CATEGORY_LABELS['23']).toBeUndefined();
        expect(SYSTEM_LOCATIONS.has('23')).toBe(false);
    });

    it('never calls a system location a category', () => {
        // A message is in the inbox *and* in a category; both arrive as plain label ids in the same
        // array, and only these two lists tell them apart.
        for (const id of Object.keys(CATEGORY_LABELS)) {
            expect(SYSTEM_LOCATIONS.has(id), `${id} is in both lists`).toBe(false);
        }
    });
});

describe('deciding what counts as a category on a message', () => {
    it('keeps the categories and drops the locations', () => {
        expect(categoryIdsOf(['0', '5', '25'], NO_FOLDERS)).toEqual(['25']);
    });

    it('does not mistake a snoozed or soft-deleted message for a category', () => {
        // The actual bug: both ids are two digits, so the shape test alone let them through and the
        // user was told about an "unbekannte Kategorie 16" that is Proton's snooze.
        expect(categoryIdsOf(['0', '16'], NO_FOLDERS)).toEqual([]);
        expect(categoryIdsOf(['40'], NO_FOLDERS)).toEqual([]);
    });

    it('reports an unrecognised category id rather than dropping it', () => {
        // Proton can add one tomorrow. The mailbox is the only evidence we would ever get, so an
        // id that fits the shape is surfaced and marked unknown further up.
        expect(categoryIdsOf(['0', '27'], NO_FOLDERS)).toEqual(['27']);
    });

    it("never treats one of the account's own folders as a category", () => {
        // A user folder normally has a long opaque id, but nothing stops Proton from handing out a
        // short one, and a folder misread as a category would appear as a phantom tab.
        expect(categoryIdsOf(['0', '27'], new Set(['27']))).toEqual([]);
    });

    it('ignores the long ids that folders and labels actually use', () => {
        expect(categoryIdsOf(['aBc123XyZ_dEf456GhI789=='], NO_FOLDERS)).toEqual([]);
    });
});
