/**
 * The local mirror of a Proton mailbox.
 *
 * Everything here is a *copy* of something Proton owns. Nothing in this database is authoritative:
 * a sync overwrites it, and losing the file costs a resync, not data. That is deliberate — it keeps
 * the question "which side is right?" from ever arising, and it is why the whole file can be
 * encrypted and thrown away without ceremony.
 *
 * Migrations are an ordered list applied inside one transaction, tracked by SQLite's own
 * `user_version`. Appending is the only permitted edit: changing a past step means two machines
 * disagree about what version 3 was.
 */

export interface Migration {
    readonly summary: string;
    readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
    {
        summary: 'folders, labels, filters, message metadata',
        sql: `
            CREATE TABLE meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT;

            -- Proton models folders and labels as one object distinguished by Type, and so do we:
            -- diverging here would mean translating in both directions for no gain.
            CREATE TABLE labels (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                path       TEXT NOT NULL,
                parent_id  TEXT,
                type       INTEGER NOT NULL,
                color      TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                notify     INTEGER NOT NULL DEFAULT 0
            ) STRICT;

            CREATE INDEX labels_parent ON labels (parent_id);
            CREATE INDEX labels_type ON labels (type);

            CREATE TABLE filters (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                status      INTEGER NOT NULL,
                priority    INTEGER NOT NULL,
                version     INTEGER NOT NULL,
                -- Kept verbatim. The Sieve is what Proton actually runs, and Tree is what our own
                -- compiler is checked against; a filter authored as Sieve has no Simple at all.
                sieve       TEXT,
                tree_json   TEXT,
                simple_json TEXT,
                -- Whether this tool is managing the rule, or found it and is waiting to be told.
                adopted     INTEGER NOT NULL DEFAULT 0
            ) STRICT;

            CREATE INDEX filters_priority ON filters (priority);

            CREATE TABLE messages (
                id              TEXT PRIMARY KEY,
                subject         TEXT NOT NULL,
                sender_address  TEXT NOT NULL,
                sender_name     TEXT NOT NULL DEFAULT '',
                time            INTEGER NOT NULL,
                unread          INTEGER NOT NULL DEFAULT 0,
                num_attachments INTEGER NOT NULL DEFAULT 0,
                conversation_id TEXT,
                address_id      TEXT
            ) STRICT;

            CREATE INDEX messages_time ON messages (time DESC);
            CREATE INDEX messages_sender ON messages (sender_address);

            -- A message carries several labels at once, including the system ones that make it
            -- "in the inbox". Kept as rows rather than as JSON so "what is in this folder" is a
            -- query rather than a scan.
            CREATE TABLE message_labels (
                message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
                label_id   TEXT NOT NULL,
                PRIMARY KEY (message_id, label_id)
            ) STRICT;

            CREATE INDEX message_labels_label ON message_labels (label_id);

            CREATE TABLE recipients (
                message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
                kind       TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
                address    TEXT NOT NULL,
                name       TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (message_id, kind, address)
            ) STRICT;
        `,
    },
];
