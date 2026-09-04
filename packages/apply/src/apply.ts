import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { inverseOf, verifyMoves, type JournalEntry, type MovedMessage, type VerificationResult } from '@pms/changes';
import type { ProtonHttp } from '@pms/proton-api';
import { fingerprintAccount, getMessages } from '@pms/proton-api';

import { digestOf, shortDigest, type ChangeRequest } from './request.js';
import { backup, ensureFolder, readAccount, removeFilter, setEnabled, writeFilter, type Account } from './steps.js';

const log = getLogger('apply');

/**
 * Applying one confirmed change to the account.
 *
 * The order below is the product, not an implementation detail, and every step is where it is for a
 * reason that cost something to learn:
 *
 *  1. **Freshness first.** The plan the user approved described a specific mailbox. If a filter
 *     moved in Proton's own interface since, the sentence they agreed to is no longer true and the
 *     confirmation it earned no longer covers what would happen.
 *  2. **Refuse before asking.** Nobody should be asked to approve something that cannot work.
 *  3. **Confirm in the terminal.** An HTTP request is an offer. The grant is a keystroke, in a
 *     place a process on this machine cannot reach. Until it comes back, nothing has been written
 *     and nothing will be.
 *  4. **Read the before-picture.** Where the affected mail is *now*. This is the only source of the
 *     journal's per-message snapshot, and undo depends on it being observed rather than assumed.
 *  5. **Back up.** No backup, no write.
 *  6. **Write, folder before filter.**
 *  7. **Journal immediately.** A crash between writing and verifying must still leave an undoable
 *     record.
 *  8. **Verify by looking.** A write returning 200 means Proton accepted the filter, not that any
 *     mail moved. A partial result is raised, never rounded up.
 *
 * The journal's `moved` is filled from what verification *observed*, never from the plan. Undo moves
 * back exactly what the journal names, so a journal built from intentions would move back mail that
 * never moved.
 */

export type ConfirmationVerdict = 'granted' | 'declined' | 'expired';

export interface ConfirmationOffer {
    request: ChangeRequest;
    /** The six characters the dashboard shows, for comparison. */
    shortDigest: string;
    /** Why this one is being asked about when most are not. */
    reason: string;
}

/**
 * Which changes are asked about twice.
 *
 * Every change is already confirmed once: the diff dialog shows the consequences and the user
 * clicks a button naming them. Asking again in a terminal for every small rule turns that second
 * question into a reflex, and a confirmation people answer without reading protects nothing — which
 * is the same argument CLAUDE.md makes for never skipping the diff.
 *
 * So the second question is kept for the changes where being wrong is expensive: one that resorts a
 * large share of the mailbox, and one that removes something. A rule catching a handful of mails is
 * visible, checkable and undoable; a rule catching a fifth of the account, or a deletion, is not so
 * easily walked back.
 */
export const IMPACT_SHARE = 0.2;
export const IMPACT_COUNT = 500;

export function weigh(
    request: ChangeRequest,
    mailboxSize: number
): { needsTerminal: boolean; reason: string } {
    const moves = request.plan.moves.length;

    if (request.change.kind === 'delete-rule' || request.change.kind === 'delete-folder') {
        return { needsTerminal: true, reason: 'Diese Änderung löscht etwas.' };
    }
    if (moves >= IMPACT_COUNT) {
        return { needsTerminal: true, reason: `Diese Änderung sortiert ${String(moves)} Mails um.` };
    }
    if (mailboxSize > 0 && moves / mailboxSize >= IMPACT_SHARE) {
        const percent = Math.round((moves / mailboxSize) * 100);
        return {
            needsTerminal: true,
            reason: `Diese Änderung betrifft ${String(percent)} % der erfassten Mails.`,
        };
    }

    return { needsTerminal: false, reason: '' };
}

export interface ApplyContext {
    http: ProtonHttp;
    backupDir: string;
    confirm: (offer: ConfirmationOffer) => Promise<ConfirmationVerdict>;
    /** Messages in the local copy, for judging how much of the mailbox a change touches. */
    mailboxSize?: number;
    now?: () => number;
    /** Injected in tests so a verification does not wait on a real clock. */
    sleep?: (ms: number) => Promise<void>;
}

export interface ApplyOutcome {
    entry: JournalEntry;
    backupPath: string;
    /** Set when some steps landed and others did not — the state that matters most. */
    partial: AppError | undefined;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function applyChange(request: ChangeRequest, context: ApplyContext): Promise<ApplyOutcome> {
    const now = context.now ?? Date.now;
    const sleep = context.sleep ?? defaultSleep;

    // 1 — freshness
    const account = await readAccount(context.http);
    const current = fingerprintAccount(account.filters, account.folders);

    if (request.baseVersion === '') {
        // A copy made before this check existed carries no fingerprint at all. Refusing with "the
        // account changed" was a lie and, worse, an unfixable one — every rule was rejected and the
        // message pointed nowhere. Say what is actually missing.
        throw new AppError('APPLY_STATE_STALE', {
            message: 'Die lokale Kopie weiss nicht, wie das Konto aussah, als sie gemacht wurde.',
            hint:
                'Einmal synchronisieren — danach ist der Vergleich möglich und die Änderung geht ' +
                'durch. Geschrieben wurde nichts.',
            context: { change: request.change.kind },
        });
    }

    if (current !== request.baseVersion) {
        throw new AppError('APPLY_STATE_STALE', {
            message: 'Bei Proton hat sich etwas geändert, seit dieser Diff berechnet wurde.',
            hint:
                'Es wurde nichts geschrieben. Neu synchronisieren und die Änderung noch einmal ' +
                'ansehen — die Zahlen im Diff gelten sonst für ein Postfach, das es nicht mehr gibt.',
            context: { change: request.change.kind },
        });
    }

    // 2 — refuse before asking
    preflight(request, account);

    // 3 — the grant, when the change is big enough to deserve a second one
    const weight = weigh(request, context.mailboxSize ?? 0);
    if (weight.needsTerminal) {
        const verdict = await context.confirm({
            request,
            shortDigest: shortDigest(digestOf(request)),
            reason: weight.reason,
        });
        if (verdict === 'expired') {
            throw new AppError('APPLY_CONFIRMATION_EXPIRED', {
                message: 'Die Rückfrage im Terminal ist abgelaufen.',
                hint: 'Es wurde nichts geschrieben. Die Änderung im Dashboard erneut bestätigen.',
                context: { change: request.change.kind },
            });
        }
        if (verdict !== 'granted') {
            throw new AppError('APPLY_NOT_CONFIRMED', {
                message: 'Die Änderung wurde im Terminal abgelehnt.',
                hint: 'Es wurde nichts geschrieben.',
                context: { change: request.change.kind },
            });
        }
    }

    // 4 — the before-picture, observed
    const before = await readStates(context.http, request.affectedMessageIds);

    // 5 — backup
    const saved = await backup(context.http, context.backupDir, now());

    // 6 — write
    const performed = await perform(request, account, context.http);

    // 7 — journal, opened at once
    const entry: JournalEntry = {
        id: `j-${String(now())}`,
        at: now(),
        change: request.change,
        inverse: inverseOf(request.change),
        moved: [],
    };

    // 8 — verify by looking, twice if need be, because Proton files asynchronously
    let verification: VerificationResult = { confirmed: 0, stragglers: [], checkedAt: now() };
    let partial: AppError | undefined;

    if (request.plan.moves.length > 0) {
        const folderIds = new Map(performed.folders.map((folder) => [folder.name, folder.id]));
        for (const folder of account.folders) {
            folderIds.set(folder.Name, folder.ID);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                await sleep(2_000);
            }
            const actual = await readStates(context.http, request.affectedMessageIds);
            const result = verifyMoves({ expected: request.plan.moves, actual, folderIds, now: now() });
            if (result.confirmed >= verification.confirmed) {
                verification = result;
            }
            if (result.stragglers.length === 0) {
                break;
            }
        }

        entry.moved = observedMoves(request, before, verification);
        entry.verification = verification;

        if (verification.stragglers.length > 0) {
            partial = new AppError('VERIFY_PARTIAL_MOVE', {
                message: `${verification.confirmed} von ${request.plan.moves.length} Mails sind angekommen.`,
                hint:
                    'Der Filter steht bei Proton. Die übrigen Mails liegen noch, wo sie lagen — ' +
                    'Proton sortiert asynchron, ein späterer Blick kann anders ausfallen.',
                context: {
                    confirmed: verification.confirmed,
                    expected: request.plan.moves.length,
                    stragglers: verification.stragglers.length,
                },
            });
        }
    }

    if (performed.problem !== undefined) {
        partial = performed.problem;
    }

    log.info(
        {
            change: request.change.kind,
            confirmed: verification.confirmed,
            partial: partial !== undefined,
            askedTwice: weight.needsTerminal,
        },
        'change applied'
    );

    return { entry, backupPath: saved.path, partial };
}

/** Everything that can be refused before anyone is asked to approve it. */
function preflight(request: ChangeRequest, account: Account): void {
    const target = request.change.after?.rule.Actions.FileInto.at(-1);

    if (request.change.kind === 'create-folder') {
        const name = request.change.folder?.name;
        if (name !== undefined && account.folders.some((folder) => folder.Name === name)) {
            throw new AppError('FOLDER_ALREADY_EXISTS', {
                message: `Den Ordner „${name}" gibt es schon.`,
                hint: 'Es wurde nichts geschrieben.',
                context: { name },
            });
        }
    }

    if (request.change.kind === 'update-rule' || request.change.kind === 'delete-rule') {
        const id = request.change.before?.id;
        if (id !== undefined && !account.filters.some((filter) => filter.ID === id)) {
            throw new AppError('APPLY_STATE_STALE', {
                message: 'Diesen Filter gibt es bei Proton nicht mehr.',
                hint: 'Es wurde nichts geschrieben. Neu synchronisieren.',
                context: { filterId: id },
            });
        }
    }

    if (target !== undefined && target !== '' && SYSTEM_FOLDERS.has(target.toLowerCase())) {
        throw new AppError('WRITE_FOLDER_FAILED', {
            message: `„${target}" ist der Name eines Proton-Systemordners.`,
            hint: 'Ein eigener Ordner mit diesem Namen führt Mail dorthin, wo niemand nachsieht.',
            context: { target },
        });
    }
}

const SYSTEM_FOLDERS = new Set(['posteingang', 'inbox', 'papierkorb', 'trash', 'spam', 'gesendet', 'sent']);

interface Performed {
    folders: Array<{ name: string; id: string }>;
    filterId: string | undefined;
    /** Set when some steps landed and a later one did not. Deliberately not rolled back. */
    problem: AppError | undefined;
}

/**
 * Do the writes, in the one order that cannot leave a filter pointing at nothing.
 *
 * Nothing is rolled back automatically. Deleting a folder moves the mail inside it, and an error
 * path — unwatched, mid-failure — is the worst possible place to do that. A half-applied change is
 * journalled and named instead, and it can be undone through the ordinary route with a diff in
 * front of it.
 */
async function perform(request: ChangeRequest, account: Account, http: ProtonHttp): Promise<Performed> {
    const performed: Performed = { folders: [], filterId: undefined, problem: undefined };
    const change = request.change;

    const target = change.after?.rule.Actions.FileInto.at(-1);
    if (target !== undefined && target !== '') {
        const folder = await ensureFolder(http, account, target);
        if (folder.created) {
            performed.folders.push({ name: target, id: folder.id });
        }
    }

    try {
        switch (change.kind) {
            case 'create-rule':
            case 'update-rule': {
                if (change.after === undefined) {
                    break;
                }
                const filter = await writeFilter(http, {
                    id: change.kind === 'update-rule' ? change.before?.id : undefined,
                    name: change.after.name,
                    rule: change.after.rule,
                    enabled: change.after.enabled,
                });
                performed.filterId = filter.ID;
                break;
            }

            case 'delete-rule': {
                if (change.before !== undefined) {
                    await removeFilter(http, change.before.id);
                }
                break;
            }

            case 'enable-rule':
            case 'disable-rule': {
                const stored = account.filters.find((filter) => filter.ID === change.before?.id);
                if (stored !== undefined) {
                    await setEnabled(http, stored, change.kind === 'enable-rule');
                }
                break;
            }

            default:
                // Folder-only changes are already done by `ensureFolder` above, or are not
                // supported yet. Silence here would hide the second case, so it is named.
                if (change.kind !== 'create-folder') {
                    throw new AppError('APPLY_PARTIAL', {
                        message: `„${change.kind}" kann noch nicht auf das Konto geschrieben werden.`,
                        hint: 'Es wurde nichts weiter geschrieben.',
                        context: { kind: change.kind },
                    });
                }
        }
    } catch (cause) {
        if (performed.folders.length === 0) {
            throw cause;
        }
        // A folder was created and the filter was not. Not undone here: see the note above.
        performed.problem = new AppError('APPLY_PARTIAL', {
            message: `Der Ordner „${performed.folders[0]?.name ?? ''}" wurde angelegt, der Filter aber nicht.`,
            hint:
                'Der Ordner bleibt stehen — ihn im Fehlerfall automatisch zu löschen würde die Mail ' +
                'darin verschieben. Er lässt sich über den Verlauf zurücknehmen.',
            context: { folder: performed.folders[0]?.name },
            cause,
        });
    }

    return performed;
}

/** Where a set of messages is, straight from Proton. */
async function readStates(
    http: ProtonHttp,
    ids: readonly string[]
): Promise<Array<{ ID: string; LabelIDs: string[] }>> {
    if (ids.length === 0) {
        return [];
    }
    const wanted = new Set(ids);
    // No endpoint takes a list of ids, so this reads recent mail and keeps what was asked for. The
    // affected set is what a rule just moved, which is by definition recent.
    const page = await getMessages(http, { pageSize: 150 });
    return page.messages
        .filter((message) => wanted.has(message.ID))
        .map((message) => ({ ID: message.ID, LabelIDs: message.LabelIDs }));
}

/**
 * The per-message record undo will work from.
 *
 * Built from the *before* picture and the confirmed moves — not from the plan. A journal entry
 * naming a message that never moved would make undo move it back to somewhere it never left.
 */
function observedMoves(
    request: ChangeRequest,
    before: Array<{ ID: string; LabelIDs: string[] }>,
    verification: VerificationResult
): MovedMessage[] {
    const straggling = new Set(verification.stragglers);
    const previous = new Map(before.map((state) => [state.ID, state.LabelIDs]));

    return request.plan.moves
        .filter((move) => move.to !== undefined && !straggling.has(move.messageId))
        .map((move) => ({
            messageId: move.messageId,
            previousLabelIds: previous.get(move.messageId) ?? [],
            movedTo: move.to,
        }));
}
