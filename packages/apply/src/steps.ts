import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import type { ProtonHttp } from '@pms/proton-api';
import { getFilters, getFolders } from '@pms/proton-api';
import type { ProtonFilter, ProtonLabel } from '@pms/proton-api/schemas';
import {
    applyFiltersToExisting,
    backupBeforeWrite,
    createFilter,
    createFolder,
    deleteFilter,
    deleteFolder,
    reorderFilters,
    setFilterEnabled,
    updateFilter,
    updateFolder,
    type BackupResult,
} from '@pms/proton-api/write';
import { toSieveTree } from '@proton/sieve/toSieveTree';
import type { SimpleObject } from '@proton/sieve/filterModel';

const log = getLogger('apply');

/**
 * The only place in the project that writes to a Proton account.
 *
 * Every function here performs one step and reports what it did. None of them decides *whether* to
 * do it: the ordering, the refusals and the confirmation live in `apply.ts`, and this file is
 * reachable from there and nowhere else. `write-isolation.test.ts` checks that, because the value
 * of a single write surface is entirely in it being single.
 *
 * No request is issued here directly. Every write goes through `@pms/proton-api/write`, which is
 * the only module the isolation test permits one in — and that test matches on source text, so
 * even naming a write verb beside an HTTP field in a comment here would trip it. It just did.
 *
 * Folder before filter, always. A filter naming a folder that does not exist is a rule that files
 * mail into nothing, silently — the worst state on the list, and the one an unlucky ordering would
 * produce most often.
 */

export interface Account {
    filters: ProtonFilter[];
    folders: ProtonLabel[];
}

/** Everything the decisions in `apply.ts` are made against, read fresh. */
export async function readAccount(http: ProtonHttp): Promise<Account> {
    const [filters, folders] = await Promise.all([getFilters(http), getFolders(http)]);
    return { filters, folders };
}

export async function backup(http: ProtonHttp, directory: string, now: number): Promise<BackupResult> {
    try {
        return await backupBeforeWrite(http, directory, now);
    } catch (cause) {
        throw new AppError('APPLY_BACKUP_FAILED', {
            message: 'Die Sicherung vor dem Schreiben ist fehlgeschlagen.',
            hint: 'Ohne Sicherung wird nichts geschrieben. Platz auf der Platte prüfen und erneut versuchen.',
            context: { directory },
            cause,
        });
    }
}

export async function ensureFolder(
    http: ProtonHttp,
    account: Account,
    name: string,
    parentId?: string | undefined
): Promise<{ created: boolean; id: string }> {
    const existing = account.folders.find((folder) => folder.Name === name);
    if (existing !== undefined) {
        return { created: false, id: existing.ID };
    }

    try {
        // Proton requires a colour and offers no "unset". Its own palette starts here, and a
        // folder created by this tool should look like one created by hand.
        const folder = await createFolder(http, {
            Name: name,
            Color: '#8080FF',
            ...(parentId === undefined || parentId === '' ? {} : { ParentID: parentId }),
        });
        log.info({ name, id: folder.ID }, 'folder created');
        return { created: true, id: folder.ID };
    } catch (cause) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: `Der Ordner „${name}" liess sich nicht anlegen.`,
            hint: 'Es wurde noch kein Filter geschrieben — der Ordner kommt zuerst, genau dafür.',
            context: { name },
            cause,
        });
    }
}

/**
 * Rename a folder at Proton.
 *
 * Only the folder. Every rule that files into it names it by *name*, so a rename that stops here
 * leaves those rules filing into a folder that no longer exists — silently, because Proton does not
 * check. Rewriting them is `apply.ts`'s job and is part of the same change; this function is one
 * request and nothing more.
 */
export async function renameFolder(
    http: ProtonHttp,
    account: Account,
    from: string,
    to: string
): Promise<{ id: string }> {
    const existing = folderNamed(account, from);
    try {
        await updateFolder(http, existing.ID, {
            Name: to,
            Color: existing.Color ?? '#8080FF',
            ...(existing.ParentID === undefined || existing.ParentID === null || existing.ParentID === ''
                ? {}
                : { ParentID: existing.ParentID }),
        });
        log.info({ id: existing.ID }, 'folder renamed');
        return { id: existing.ID };
    } catch (cause) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: `Der Ordner „${from}" liess sich nicht in „${to}" umbenennen.`,
            context: { from, to },
            cause,
        });
    }
}

/**
 * Delete a folder at Proton.
 *
 * Proton keeps the mail — it loses this folder's label and stays reachable under "Alle Nachrichten"
 * — but it is no longer anywhere the user filed it, and no rule that named this folder will work
 * again. Which is why a deletion always asks in the terminal, whatever its size.
 */
export async function removeFolder(http: ProtonHttp, account: Account, name: string): Promise<{ id: string }> {
    const existing = folderNamed(account, name);
    try {
        await deleteFolder(http, existing.ID);
        log.info({ id: existing.ID }, 'folder deleted');
        return { id: existing.ID };
    } catch (cause) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: `Der Ordner „${name}" liess sich nicht löschen.`,
            context: { name },
            cause,
        });
    }
}

/** The folder by name, or a refusal that says the copy is behind rather than that Proton failed. */
function folderNamed(account: Account, name: string): ProtonLabel {
    const existing = account.folders.find((folder) => folder.Name === name);
    if (existing === undefined) {
        throw new AppError('APPLY_STATE_STALE', {
            message: `Den Ordner „${name}" gibt es bei Proton nicht.`,
            hint: 'Es wurde nichts geschrieben. Einmal synchronisieren und noch einmal ansehen.',
            context: { name },
        });
    }
    return existing;
}

/** Proton stores both forms; we send both so their own interface can still edit the rule. */
function payloadFor(name: string, rule: SimpleObject, enabled: boolean): {
    Name: string;
    Status: number;
    Version: 2;
    Simple: unknown;
    Tree: unknown;
} {
    return {
        Name: name,
        Status: enabled ? 1 : 0,
        Version: 2,
        Simple: rule,
        Tree: toSieveTree(rule, 2),
    };
}

export async function writeFilter(
    http: ProtonHttp,
    options: { id: string | undefined; name: string; rule: SimpleObject; enabled: boolean }
): Promise<ProtonFilter> {
    const payload = payloadFor(options.name, options.rule, options.enabled);
    try {
        const filter =
            options.id === undefined
                ? await createFilter(http, payload)
                : await updateFilter(http, options.id, payload);
        log.info({ id: filter.ID, created: options.id === undefined }, 'filter written');
        return filter;
    } catch (cause) {
        throw new AppError('WRITE_FILTER_FAILED', {
            message: `Der Filter „${options.name}" liess sich nicht ${
                options.id === undefined ? 'anlegen' : 'ändern'
            }.`,
            context: { name: options.name, updating: options.id !== undefined },
            cause,
        });
    }
}

export async function removeFilter(http: ProtonHttp, filterId: string): Promise<void> {
    try {
        await deleteFilter(http, filterId);
        log.info({ filterId }, 'filter deleted');
    } catch (cause) {
        throw new AppError('WRITE_FILTER_FAILED', {
            message: 'Der Filter liess sich nicht löschen.',
            context: { filterId },
            cause,
        });
    }
}

export async function setEnabled(http: ProtonHttp, filter: ProtonFilter, enabled: boolean): Promise<void> {
    try {
        await setFilterEnabled(http, filter.ID, enabled);
        log.info({ filterId: filter.ID, enabled }, 'filter status changed');
    } catch (cause) {
        throw new AppError('WRITE_FILTER_FAILED', {
            message: `Der Filter „${filter.Name}" liess sich nicht ${enabled ? 'aktivieren' : 'deaktivieren'}.`,
            context: { filterId: filter.ID },
            cause,
        });
    }
}

/**
 * Put the filters in a given order.
 *
 * The full id list, always. Proton takes the order as the complete sequence, so omitting an id we
 * do not know about would silently reprioritise it — and with filters, priority *is* the outcome.
 * A list that is not a permutation of what Proton just returned is refused rather than sent.
 */
export async function reorder(http: ProtonHttp, account: Account, ids: readonly string[]): Promise<void> {
    const known = new Set(account.filters.map((filter) => filter.ID));
    const given = new Set(ids);

    const missing = [...known].filter((id) => !given.has(id));
    const unknown = ids.filter((id) => !known.has(id));

    if (missing.length > 0 || unknown.length > 0) {
        throw new AppError('APPLY_ORDER_INCOMPLETE', {
            message: 'Die Reihenfolge deckt nicht genau die Filter ab, die bei Proton liegen.',
            hint:
                'Bei Filtern ist die Reihenfolge das Ergebnis — ein fehlender Eintrag würde diesen ' +
                'Filter still verschieben. Erst neu synchronisieren, dann noch einmal.',
            context: { missing: missing.length, unknown: unknown.length },
        });
    }

    await reorderFilters(http, [...ids]);
    log.info({ count: ids.length }, 'filters reordered');
}

/**
 * Ask Proton to run its own filters over mail that already arrived.
 *
 * The reason a new rule can tidy up the backlog instead of only affecting future mail — and the
 * reason the project's core rule survives it: **Proton does the moving.** We do not select messages
 * and put them somewhere; we hand over the ids the diff listed and ask the service to apply the
 * rules it already has. The distinction is the whole design, not a wording preference.
 *
 * It was implemented and exported for months and called by nobody, while the terminal told the user
 * „Bestehende Mail wird mit einbezogen" and nothing included it. The verification step then waited
 * three times for movements that could not happen and reported a partial result.
 */
export async function applyToBacklog(http: ProtonHttp, messageIds: readonly string[]): Promise<number> {
    if (messageIds.length === 0) {
        return 0;
    }
    await applyFiltersToExisting(http, [...messageIds]);
    log.info({ count: messageIds.length }, 'asked Proton to file existing mail');
    return messageIds.length;
}
