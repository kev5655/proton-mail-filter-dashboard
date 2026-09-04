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
    {
        summary: 'category history, so Proton\'s own sorting can be observed over time',
        sql: `
            -- Which of Proton's categories a message carried, and when that stopped being true.
            --
            -- Proton sorts inbox mail into categories by itself and keeps doing it once a message
            -- has been filed. That behaviour has no interface, no filter and no list: it is only
            -- visible in its effect. And its effect is unrecoverable from the rest of this
            -- database, because \`mirrorMessages\` clears and rewrites \`message_labels\` on every
            -- sync — after which what a message carried yesterday is simply gone.
            --
            -- So this table remembers. It is the only thing in the mirror that is not a copy of a
            -- current Proton state, and it is deliberately append-mostly: rows are opened and
            -- closed, never rewritten, because a history that is edited is not a history.
            CREATE TABLE message_categories (
                message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
                category_id TEXT NOT NULL,
                -- Sync timestamps, not message timestamps. The question is when *we looked*.
                first_seen  INTEGER NOT NULL,
                last_seen   INTEGER NOT NULL,
                -- Set by the first sync that saw the message without this category.
                gone_at     INTEGER,
                PRIMARY KEY (message_id, category_id)
            ) STRICT;

            CREATE INDEX message_categories_seen ON message_categories (first_seen);

            -- The same observation aggregated per sender and per sync.
            --
            -- Derivable from the table above by joining against messages, and stored anyway: the
            -- screen that shows "what does Proton do with this sender" would otherwise scan the
            -- whole message table on every render, and the aggregate is what every question on
            -- that screen is actually about.
            CREATE TABLE category_observations (
                sender_address TEXT NOT NULL,
                -- Kept alongside the address rather than derived on read, so "what does Proton do
                -- with this whole domain" is a query rather than a scan plus string surgery.
                sender_domain  TEXT NOT NULL,
                category_id    TEXT NOT NULL,
                observed_at    INTEGER NOT NULL,
                message_count  INTEGER NOT NULL,
                PRIMARY KEY (sender_address, category_id, observed_at)
            ) STRICT;

            CREATE INDEX category_observations_at ON category_observations (observed_at);
            CREATE INDEX category_observations_domain
                ON category_observations (sender_domain, observed_at);
        `,
    },
    {
        summary: 'the record of what was changed at Proton, and how to take it back',
        sql: `
            -- What this tool did to the account, and the means to undo it.
            --
            -- It existed before this table, and only in a browser tab. \`applyChange\` built a
            -- correct entry — from what verification *observed*, not from what the plan intended —
            -- and the process that called it dropped the value on the floor. So „Verlauf" was
            -- permanently empty against a real account, and \`undoChange\` had no caller anywhere in
            -- the project.
            --
            -- Two things are kept per entry and both are needed. The **inverse change** puts the
            -- rules back; the **per-message snapshot** puts the mail back. Neither alone is enough:
            -- deleting a rule does not return the mail it filed, and moving mail back while the
            -- rule still runs means it is filed again within the hour.
            --
            -- \`moved_json\` holds message ids and label ids and nothing else — no subjects, no
            -- senders. The diff had those and did not need to keep them; what is not stored cannot
            -- leak out of a backup or an error report.
            CREATE TABLE journal_entries (
                id            TEXT PRIMARY KEY,
                -- Unix seconds, when the change was applied.
                at            INTEGER NOT NULL,
                kind          TEXT NOT NULL,
                summary       TEXT NOT NULL,
                change_json   TEXT NOT NULL,
                inverse_json  TEXT NOT NULL,
                -- MovedMessage[]: id, the labels it carried before, where it went.
                moved_json    TEXT NOT NULL,
                -- What the check afterwards actually saw. Absent when nothing was expected to move.
                verification_json TEXT,
                -- The full backup taken before the write. The one file that can rebuild the rest.
                backup_path   TEXT NOT NULL,
                -- Set when this entry has been taken back, so it is not offered twice.
                undone_at     INTEGER,
                -- Set when this entry *is* an undo, naming what it took back. A rewind is a chain
                -- of these, and reading the chain is how a half-finished rewind stays explicable.
                undoes_id     TEXT
            ) STRICT;

            CREATE INDEX journal_entries_at ON journal_entries (at);
        `,
    },
];
