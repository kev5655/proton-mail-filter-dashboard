import type { Db } from '@pms/store';

/**
 * Reading the local copy.
 *
 * These are the shapes the interface works in, which is not quite the shape Proton sends. Two
 * differences are deliberate:
 *
 *  - A folder carries its **depth** and its children, because a flat list with parent ids is
 *    something every screen would otherwise have to assemble again.
 *  - A message carries its **labels** as an array, because "is this in the inbox" is the question
 *    asked most often and a join per message is not it.
 *
 * Nothing here talks to Proton. If the copy is stale, the answer is stale — which is why the sync
 * timestamp is part of what the interface shows, not a detail hidden in a log.
 */

export interface StoredFolder {
    id: string;
    name: string;
    path: string;
    parentId: string | undefined;
    type: number;
    color: string | undefined;
    /** 0 at the top level. Precomputed so a tree view does not have to walk parents. */
    depth: number;
    children: StoredFolder[];
}

export interface StoredMessage {
    id: string;
    subject: string;
    sender: { address: string; name: string };
    time: number;
    unread: boolean;
    numAttachments: number;
    labelIds: string[];
}

export interface StoredFilter {
    id: string;
    name: string;
    enabled: boolean;
    priority: number;
    version: number;
    sieve: string | undefined;
    tree: unknown;
    simple: unknown;
    /** False for a rule found in Proton that the user has not yet accepted. */
    adopted: boolean;
    /** How it was written, which decides whether Proton's own UI can still edit it. */
    authoredAs: 'tree' | 'sieve';
}

interface LabelRow {
    id: string;
    name: string;
    path: string;
    parent_id: string | null;
    type: number;
    color: string | null;
}

/**
 * The folder tree, roots first.
 *
 * Built in one pass over one query. A recursive query per level would be tidier to read and would
 * cost a round trip per level of nesting.
 */
export function readFolderTree(db: Db, type = 3): StoredFolder[] {
    const rows = db
        .prepare('SELECT id, name, path, parent_id, type, color FROM labels WHERE type = ? ORDER BY sort_order, name')
        .all(type) as LabelRow[];

    const byId = new Map<string, StoredFolder>();
    for (const row of rows) {
        byId.set(row.id, {
            id: row.id,
            name: row.name,
            path: row.path,
            parentId: row.parent_id ?? undefined,
            type: row.type,
            color: row.color ?? undefined,
            depth: 0,
            children: [],
        });
    }

    const roots: StoredFolder[] = [];
    for (const folder of byId.values()) {
        const parent = folder.parentId === undefined ? undefined : byId.get(folder.parentId);
        if (parent === undefined) {
            // Also catches a folder whose parent is missing from the copy. Showing it at the top is
            // better than dropping it: a folder the user can see in Proton but not here reads as
            // data loss, and an orphan is a sync problem worth noticing rather than hiding.
            roots.push(folder);
        } else {
            parent.children.push(folder);
        }
    }

    const setDepth = (folder: StoredFolder, depth: number): void => {
        folder.depth = depth;
        for (const child of folder.children) {
            setDepth(child, depth + 1);
        }
    };
    for (const root of roots) {
        setDepth(root, 0);
    }

    return roots;
}

export function readFilters(db: Db): StoredFilter[] {
    const rows = db
        .prepare(
            'SELECT id, name, status, priority, version, sieve, tree_json, simple_json, adopted FROM filters ORDER BY priority'
        )
        .all() as Array<{
        id: string;
        name: string;
        status: number;
        priority: number;
        version: number;
        sieve: string | null;
        tree_json: string | null;
        simple_json: string | null;
        adopted: number;
    }>;

    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.status === 1,
        priority: row.priority,
        version: row.version,
        sieve: row.sieve ?? undefined,
        tree: row.tree_json === null ? undefined : (JSON.parse(row.tree_json) as unknown),
        simple: row.simple_json === null ? undefined : (JSON.parse(row.simple_json) as unknown),
        adopted: row.adopted === 1,
        // A filter written as Sieve has no Simple form at all — Proton's own interface shows it as
        // code and nothing else. Which one it is changes what the user may do with it.
        authoredAs: row.simple_json === null ? 'sieve' : 'tree',
    }));
}

export interface MessageQuery {
    /** Only messages carrying this label or folder. */
    labelId?: string;
    limit?: number;
    offset?: number;
}

export function readMessages(db: Db, query: MessageQuery = {}): StoredMessage[] {
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;

    const rows = (
        query.labelId === undefined
            ? db
                  .prepare(
                      `SELECT id, subject, sender_address, sender_name, time, unread, num_attachments
                       FROM messages ORDER BY time DESC LIMIT ? OFFSET ?`
                  )
                  .all(limit, offset)
            : db
                  .prepare(
                      `SELECT m.id, m.subject, m.sender_address, m.sender_name, m.time, m.unread, m.num_attachments
                       FROM messages m
                       JOIN message_labels ml ON ml.message_id = m.id
                       WHERE ml.label_id = ?
                       ORDER BY m.time DESC LIMIT ? OFFSET ?`
                  )
                  .all(query.labelId, limit, offset)
    ) as Array<{
        id: string;
        subject: string;
        sender_address: string;
        sender_name: string;
        time: number;
        unread: number;
        num_attachments: number;
    }>;

    if (rows.length === 0) {
        return [];
    }

    // One query for all the labels rather than one per message: a page of 200 was 200 round trips
    // through the driver, and it showed.
    const placeholders = rows.map(() => '?').join(', ');
    const labelRows = db
        .prepare(`SELECT message_id, label_id FROM message_labels WHERE message_id IN (${placeholders})`)
        .all(...rows.map((row) => row.id)) as Array<{ message_id: string; label_id: string }>;

    const labelsByMessage = new Map<string, string[]>();
    for (const row of labelRows) {
        const existing = labelsByMessage.get(row.message_id);
        if (existing === undefined) {
            labelsByMessage.set(row.message_id, [row.label_id]);
        } else {
            existing.push(row.label_id);
        }
    }

    return rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        sender: { address: row.sender_address, name: row.sender_name },
        time: row.time,
        unread: row.unread === 1,
        numAttachments: row.num_attachments,
        labelIds: labelsByMessage.get(row.id) ?? [],
    }));
}
