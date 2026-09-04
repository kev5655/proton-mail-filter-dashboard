import type { MessageMetadata, ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import type { Db } from '@pms/store';

/**
 * Writing Proton's answers into the local database.
 *
 * Nothing here decides anything. It takes what Proton said and makes the local copy say the same —
 * which is the whole contract of this file: after a mirror call, a table matches the response it
 * was given, including things that disappeared.
 *
 * That last part is why labels and filters are replaced wholesale rather than upserted. They are
 * small, they arrive complete, and an upsert would leave a folder in our copy that the user deleted
 * in Proton an hour ago — which would then show up as a destination we offer them, or worse, as a
 * rule target that no longer exists. Being wrong in that direction is not worth the saved writes.
 *
 * Messages are different: they arrive a page at a time and a window at a time, so absence from one
 * batch means nothing. They are upserted, and deletions wait for the event loop.
 */

/** Everything a full mirror needs, so the caller cannot half-apply one by forgetting an argument. */
export interface Snapshot {
    folders: readonly ProtonLabel[];
    labels: readonly ProtonLabel[];
    filters: readonly ProtonFilter[];
}

export function mirrorLabels(db: Db, snapshot: Pick<Snapshot, 'folders' | 'labels'>): number {
    const all = [...snapshot.folders, ...snapshot.labels];

    const insert = db.prepare(`
        INSERT INTO labels (id, name, path, parent_id, type, color, sort_order, notify)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
        db.exec('DELETE FROM labels');
        for (const label of all) {
            insert.run(
                label.ID,
                label.Name,
                label.Path ?? label.Name,
                // Proton uses both an absent field and an empty string for "top level"; one of them
                // here, so the tree can be walked with a single IS NULL.
                label.ParentID === undefined || label.ParentID === null || label.ParentID === ''
                    ? null
                    : label.ParentID,
                label.Type,
                label.Color ?? null,
                label.Order ?? 0,
                label.Notify ?? 0
            );
        }
    })();

    return all.length;
}

export function mirrorFilters(db: Db, filters: readonly ProtonFilter[]): number {
    const insert = db.prepare(`
        INSERT INTO filters (id, name, status, priority, version, sieve, tree_json, simple_json, adopted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    /*
     * Which rules the user has already accepted responsibility for.
     *
     * Replacing the table would otherwise silently un-adopt every one of them, and they would all
     * reappear as "found in Proton, please confirm" — training people to click through the
     * confirmation.
     *
     * A filter that is *not* in this set after a first sync is one that appeared at Proton without
     * this tool doing it. That is the drift the „Änderungen" screen is for, and it used to be
     * invisible: a rule created in Proton's own interface simply turned up among the others, as
     * though the tool had known about it all along.
     *
     * The first mirror is the exception and adopts everything. A brand new copy has no history to
     * compare against, so calling the user's entire existing rule set "unexpected" would be both
     * wrong and the fastest possible way to teach them to dismiss the screen.
     */
    const known = db.prepare('SELECT id, adopted FROM filters').all() as Array<{
        id: string;
        adopted: number;
    }>;
    const first = known.length === 0;
    const adopted = new Set(known.filter((row) => row.adopted === 1).map((row) => row.id));

    db.transaction(() => {
        db.exec('DELETE FROM filters');
        for (const filter of filters) {
            insert.run(
                filter.ID,
                filter.Name,
                filter.Status,
                filter.Priority,
                filter.Version,
                filter.Sieve ?? null,
                filter.Tree === undefined ? null : JSON.stringify(filter.Tree),
                filter.Simple === undefined ? null : JSON.stringify(filter.Simple),
                first || adopted.has(filter.ID) ? 1 : 0
            );
        }
    })();

    return filters.length;
}

/**
 * Add or update a page of messages.
 *
 * Labels and recipients are deleted and rewritten per message rather than merged: a message that
 * moved folders has *fewer* labels than before, and a merge would keep it in both places.
 */
export function mirrorMessages(db: Db, messages: readonly MessageMetadata[]): number {
    const upsert = db.prepare(`
        INSERT INTO messages (
            id, subject, sender_address, sender_name, time, unread, num_attachments,
            conversation_id, address_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
            subject         = excluded.subject,
            sender_address  = excluded.sender_address,
            sender_name     = excluded.sender_name,
            time            = excluded.time,
            unread          = excluded.unread,
            num_attachments = excluded.num_attachments,
            conversation_id = excluded.conversation_id,
            address_id      = excluded.address_id
    `);
    const clearLabels = db.prepare('DELETE FROM message_labels WHERE message_id = ?');
    const addLabel = db.prepare('INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)');
    const clearRecipients = db.prepare('DELETE FROM recipients WHERE message_id = ?');
    const addRecipient = db.prepare(
        'INSERT OR IGNORE INTO recipients (message_id, kind, address, name) VALUES (?, ?, ?, ?)'
    );

    db.transaction(() => {
        for (const message of messages) {
            upsert.run(
                message.ID,
                message.Subject,
                message.Sender.Address,
                message.Sender.Name ?? '',
                message.Time,
                message.Unread,
                message.NumAttachments ?? 0,
                message.ConversationID ?? null,
                message.AddressID ?? null
            );

            clearLabels.run(message.ID);
            for (const labelId of message.LabelIDs) {
                addLabel.run(message.ID, labelId);
            }

            clearRecipients.run(message.ID);
            for (const [kind, list] of [
                ['to', message.ToList],
                ['cc', message.CCList ?? []],
                ['bcc', message.BCCList ?? []],
            ] as const) {
                for (const recipient of list) {
                    addRecipient.run(message.ID, kind, recipient.Address, recipient.Name ?? '');
                }
            }
        }
    })();

    return messages.length;
}

/** Small key-value notes about the mirror itself: when it last ran, which account it belongs to. */
export function setMeta(db: Db, key: string, value: string): void {
    db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
}

export function getMeta(db: Db, key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
}

/**
 * Record that the user has taken responsibility for these filters.
 *
 * Called for a rule this tool wrote — it is not a surprise if we made it — and for one the user
 * looked at on the „Änderungen" screen and kept. Nothing else marks a filter adopted, which is what
 * makes the absence of the flag mean something.
 */
export function markAdopted(db: Db, filterIds: readonly string[]): number {
    if (filterIds.length === 0) {
        return 0;
    }
    const update = db.prepare('UPDATE filters SET adopted = 1 WHERE id = ?');
    let changed = 0;
    db.transaction(() => {
        for (const id of filterIds) {
            changed += update.run(id).changes;
        }
    })();
    return changed;
}
