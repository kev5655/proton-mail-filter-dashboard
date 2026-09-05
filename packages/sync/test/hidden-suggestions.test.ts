import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabase, openDatabase, type Db } from '@pms/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readHiddenSuggestions, setSuggestionHidden } from '../src/hidden-suggestions.js';

/**
 * The suggestions somebody has put away.
 *
 * The behaviour that matters is that it *lasts*: this replaces a React state that forgot everything
 * on reload, so „does it come back" is the whole test.
 */

const PASSPHRASE = 'eine-lange-zufaellige-passphrase';

let directory: string;
let db: Db;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pms-hidden-'));
    db = await openDatabase({ path: join(directory, 'mailbox.db'), passphrase: PASSPHRASE });
});

afterEach(async () => {
    closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
});

describe('putting a suggestion away', () => {
    it('keeps it, with the moment it was decided', () => {
        setSuggestionHidden(db, 'sender:rechnung@bank.example', true, 1_700_000_000);

        expect(readHiddenSuggestions(db)).toEqual([
            { groupKey: 'sender:rechnung@bank.example', atSeconds: 1_700_000_000 },
        ]);
    });

    it('takes it back out', () => {
        setSuggestionHidden(db, 'sender:rechnung@bank.example', true, 1_700_000_000);
        setSuggestionHidden(db, 'sender:rechnung@bank.example', false, 1_700_000_100);

        expect(readHiddenSuggestions(db)).toEqual([]);
    });

    it('does not mind being told twice', () => {
        // The screen can be open in two tabs, and the same key arriving again must not fail or
        // double up — it is a decision about a pattern, not an event.
        setSuggestionHidden(db, 'domain@shop.example', true, 1_700_000_000);
        setSuggestionHidden(db, 'domain@shop.example', true, 1_700_000_500);

        expect(readHiddenSuggestions(db)).toEqual([{ groupKey: 'domain@shop.example', atSeconds: 1_700_000_500 }]);
    });

    it('takes nothing back that was never put away', () => {
        setSuggestionHidden(db, 'nie-versteckt', false, 1_700_000_000);

        expect(readHiddenSuggestions(db)).toEqual([]);
    });

    it('lists the most recent decision first', () => {
        setSuggestionHidden(db, 'alt', true, 1_700_000_000);
        setSuggestionHidden(db, 'neu', true, 1_700_009_999);

        expect(readHiddenSuggestions(db).map((entry) => entry.groupKey)).toEqual(['neu', 'alt']);
    });

    it('keeps every one of them, because a cap would make a decision reappear unexplained', () => {
        // The journal has a limit: it holds message ids and exists to be undone from. This holds
        // one key per pattern somebody explicitly decided about, and dropping the oldest would
        // bring a suggestion back months later with nothing to blame it on.
        for (let index = 0; index < 200; index++) {
            setSuggestionHidden(db, `gruppe-${String(index)}`, true, 1_700_000_000 + index);
        }

        expect(readHiddenSuggestions(db)).toHaveLength(200);
    });
});
