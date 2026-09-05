import { getLogger } from '@pms/core/logger';
import type { Db } from '@pms/store';

const log = getLogger('suggestions');

/**
 * The suggestions somebody has put away.
 *
 * „Nicht vorschlagen" used to be a `useState` and nothing more: it lasted until the page was
 * reloaded or another screen was opened, and then everything came back. The identity to store it
 * under already existed — `group.key` is documented as stable so that a group „can be dismissed
 * persistently" — only the storing did not.
 *
 * It lives in the encrypted local database rather than in the browser, because the same account is
 * read from more than one device and three browsers would keep three lists that disagree about
 * what is still open.
 *
 * Nothing here is mail. A group key describes a pattern — a sender, a subject shape, a domain — and
 * this table holds that and the moment it was put away, which is the whole record.
 *
 * There is deliberately **no cap**. The journal has one because it holds message ids and exists to
 * be undone from; this holds a key per pattern somebody has explicitly decided about, and dropping
 * the oldest would make a suggestion reappear months later with no explanation.
 */

interface Row {
    group_key: string;
    at_seconds: number;
}

export interface HiddenSuggestion {
    groupKey: string;
    /** Unix seconds. */
    atSeconds: number;
}

/**
 * Put one away, or bring it back.
 *
 * One function for both directions rather than a hide and an unhide, because the screen offers one
 * toggle and two functions would let the two halves drift apart.
 */
export function setSuggestionHidden(db: Db, groupKey: string, hidden: boolean, atSeconds: number): void {
    if (hidden) {
        db.prepare('INSERT OR REPLACE INTO hidden_suggestions (group_key, at_seconds) VALUES (?, ?)').run(
            groupKey,
            atSeconds
        );
    } else {
        db.prepare('DELETE FROM hidden_suggestions WHERE group_key = ?').run(groupKey);
    }
    log.info({ hidden }, 'suggestion visibility changed');
}

/** Newest first: what was put away most recently is what somebody is most likely to want back. */
export function readHiddenSuggestions(db: Db): HiddenSuggestion[] {
    const rows = db
        .prepare('SELECT group_key, at_seconds FROM hidden_suggestions ORDER BY at_seconds DESC, group_key')
        .all() as Row[];

    return rows.map((row) => ({ groupKey: row.group_key, atSeconds: row.at_seconds }));
}
