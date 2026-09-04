import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { CATEGORY_LABELS } from '@pms/grouping';
import { inverseOf, verifyMoves, type JournalEntry, type MovedMessage, type VerificationResult } from '@pms/changes';
import type { ProtonHttp } from '@pms/proton-api';
import { fingerprintAccount, getMessages } from '@pms/proton-api';

import type { PendingChange } from '@pms/changes';
import type { SimpleObject } from '@proton/sieve/filterModel';

import { digestOf, shortDigest, type ChangeRequest } from './request.js';
import {
    applyToBacklog,
    backup,
    ensureFolder,
    readAccount,
    removeFilter,
    removeFolder,
    renameFolder,
    setEnabled,
    writeFilter,
    type Account,
} from './steps.js';

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
    /** Where the answer has to come from. The runner routes on this; it never decides it. */
    place: Exclude<ConfirmationPlace, 'none'>;
}

/**
 * Which changes are asked about twice, and where the second question is asked.
 *
 * Every change is already confirmed once: the diff dialog shows the consequences and the user
 * clicks a button naming them. Asking again for every small rule turns the second question into a
 * reflex, and a confirmation people answer without reading protects nothing — which is the same
 * argument CLAUDE.md makes for never skipping the diff.
 *
 * So the second question is kept for the changes where being wrong is expensive. What changed is
 * *where* it is asked, and only for deletions:
 *
 *  - **`terminal`** — a keystroke where `pnpm serve` runs, in a place no HTTP request can reach.
 *    Kept for everything that moves mail: a category move, an undo, a rewind, and any change that
 *    resorts a large share of the mailbox.
 *  - **`password`** — the app password, re-entered in the dashboard, next to a preview of what is
 *    about to disappear. Deletions only.
 *
 * The exchange is deliberate and worth stating plainly, because it is a real one. A terminal
 * keystroke cannot be produced by anything speaking HTTP; a password can, by anything that knows
 * it. What it gains is that the person deleting a folder sees, at that moment, which mail is inside
 * it and where that mail will end up — and a confirmation somebody has to walk to another window
 * for is one they learn to perform without reading, which is the failure this whole file is built
 * against.
 *
 * It is also a secret rather than a gesture: a stray local process can `POST /api/apply`, but it
 * cannot produce the password, and a wrong one is refused by the same `Vault` that holds the key to
 * the mailbox. Where there is no account — an installation with no password to ask for — the
 * terminal keeps the deletion, because then the gesture is all there is.
 */
export const IMPACT_SHARE = 0.2;
export const IMPACT_COUNT = 500;

/** Where the second question is asked, when there is one. */
export type ConfirmationPlace = 'none' | 'password' | 'terminal';

export interface Weight {
    /** True for anything that needs a second confirmation, wherever it is asked. */
    needsTerminal: boolean;
    place: ConfirmationPlace;
    reason: string;
}

export function weigh(request: ChangeRequest, mailboxSize: number): Weight {
    const moves = request.plan.moves.length;
    const terminal = (reason: string): Weight => ({ needsTerminal: true, place: 'terminal', reason });

    // Before the size rules, and unconditional. This is the change kind that moves mail, the second
    // exception to the first sentence of CLAUDE.md, and it should cost a keystroke every single
    // time — including for one message. The thresholds below exist to keep the terminal question
    // worth reading; exempting the one kind that touches somebody's mail would defeat that.
    if (request.change.kind === 'move-to-category') {
        return terminal('Diese Änderung verschiebt Mail.');
    }
    // Likewise unconditional, and for the same reason: an undo moves mail back and removes a rule.
    // It is also the change most likely to be reached for in a hurry.
    if (request.change.kind === 'undo-entry') {
        return terminal('Diese Änderung nimmt eine frühere zurück und verschiebt Mail.');
    }
    if (request.change.kind === 'rewind-to') {
        return terminal('Diese Änderung nimmt mehrere frühere zurück und verschiebt Mail.');
    }
    if (request.change.kind === 'delete-rule' || request.change.kind === 'delete-folder') {
        return {
            needsTerminal: true,
            place: 'password',
            reason: 'Diese Änderung löscht etwas.',
        };
    }
    if (moves >= IMPACT_COUNT) {
        return terminal(`Diese Änderung sortiert ${String(moves)} Mails um.`);
    }
    if (mailboxSize > 0 && moves / mailboxSize >= IMPACT_SHARE) {
        const percent = Math.round((moves / mailboxSize) * 100);
        return terminal(`Diese Änderung betrifft ${String(percent)} % der erfassten Mails.`);
    }

    return { needsTerminal: false, place: 'none', reason: '' };
}

export interface ApplyContext {
    http: ProtonHttp;
    backupDir: string;
    confirm: (offer: ConfirmationOffer) => Promise<ConfirmationVerdict>;
    /** Messages in the local copy, for judging how much of the mailbox a change touches. */
    mailboxSize?: number;
    /**
     * Move named messages into one of Proton's categories.
     *
     * Injected rather than imported, the same way undo gets its `applyInverse`. `steps.ts` is the
     * only file allowed to touch the write barrel and the message-moving module is not in it, so
     * neither this file nor `steps.ts` can reach the code that performs this. It arrives from
     * `apps/spike/src/serve-command.ts`, outside everything HTTP can address.
     *
     * Absent means the capability is not wired up, and a category move is then refused rather than
     * reported as done.
     */
    moveToCategory?: (messageIds: string[], categoryId: string) => Promise<void>;
    /**
     * Take one recorded change back.
     *
     * Injected for the same reason as `moveToCategory`, plus one of its own: undoing needs the
     * *journal*, and neither this package nor `steps.ts` can reach the database. What arrives here
     * is a function that knows the record; what it gets back is `performInverse`, which is this
     * file's own write path applied to whatever the record says the inverse is.
     *
     * The split is the point. This file decides *how a change is written*; the caller decides
     * *what was done and what has to move back*. Neither can do the other's half.
     */
    undoEntry?: (
        entryId: string,
        performInverse: (inverse: PendingChange) => Promise<void>
    ) => Promise<{ restored: number; skipped: number; unrestorable: number }>;
    /**
     * Take back everything from one recorded change onwards, newest first.
     *
     * A separate capability rather than a loop over `undoEntry`, because the *chain* is the thing
     * that needs a record: which entries were in it, which of them landed, and where it stopped.
     * That knowledge lives with the journal, not here.
     *
     * It stops at the first failure and reports it. Continuing past an error would produce an
     * account state nobody could describe afterwards — and this is an error path, which is the
     * worst possible place to keep writing unwatched.
     */
    rewindTo?: (
        entryId: string,
        performInverse: (inverse: PendingChange) => Promise<void>
    ) => Promise<{ steps: Array<{ entryId: string; restored: number }>; stoppedAt?: string | undefined }>;
    now?: () => number;
    /** Injected in tests so a verification does not wait on a real clock. */
    sleep?: (ms: number) => Promise<void>;
}

export interface ApplyOutcome {
    entry: JournalEntry;
    backupPath: string;
    /**
     * Filters the local copy should now regard as ours.
     *
     * A rule this tool wrote is not a surprise the next time the account is read, and neither is one
     * the user has just adopted. Without this every rule the dashboard created would come back on
     * the „Änderungen" screen asking to be confirmed — which is the reflex-confirmation problem, in
     * the one place whose whole job is to be worth reading.
     */
    adoptedFilterIds: string[];
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
        const where = weight.place === 'password' ? 'password' : 'terminal';
        const verdict = await context.confirm({
            request,
            shortDigest: shortDigest(digestOf(request)),
            reason: weight.reason,
            place: where,
        });
        // Named for where it was actually asked. „Die Rückfrage im Terminal ist abgelaufen" in
        // front of somebody who was looking at a password field is a message that sends them to
        // the wrong window.
        const asked = where === 'password' ? 'im Dashboard' : 'im Terminal';
        if (verdict === 'expired') {
            throw new AppError('APPLY_CONFIRMATION_EXPIRED', {
                message: `Die Rückfrage ${asked} ist abgelaufen.`,
                hint: 'Es wurde nichts geschrieben. Die Änderung erneut bestätigen.',
                context: { change: request.change.kind },
            });
        }
        if (verdict !== 'granted') {
            throw new AppError('APPLY_NOT_CONFIRMED', {
                message: `Die Änderung wurde ${asked} abgelehnt.`,
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
    const performed = await perform(request, account, context.http, context);

    /*
     * 6b — the backlog, if the user asked for it.
     *
     * After the filter exists and before verification looks, because that is the order the two
     * steps mean anything in: Proton cannot apply a rule it does not have yet, and checking for
     * movement before asking for it would report every backlog change as a failure.
     *
     * A failure here is reported and not thrown. The filter is written and correct; what did not
     * happen is the tidy-up of old mail, and losing the journal entry for a successful write over
     * that would be the worse trade.
     */
    let backlogProblem: AppError | undefined;
    if (request.applyToExisting && request.affectedMessageIds.length > 0 && performed.problem === undefined) {
        try {
            await applyToBacklog(context.http, request.affectedMessageIds);
        } catch (cause) {
            backlogProblem = new AppError('APPLY_PARTIAL', {
                message: 'Die Regel steht, aber der Bestand konnte nicht neu einsortiert werden.',
                hint:
                    'Neue Mail wird ab jetzt einsortiert. Für die vorhandene lässt sich der Vorgang ' +
                    'wiederholen — geschrieben wurde nichts Zusätzliches.',
                context: { messages: request.affectedMessageIds.length },
                cause,
            });
        }
    }

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
        // Labels as well: a rule that marks rather than moves has a destination that has to be
        // verifiable, and it is a label id in the message's `LabelIDs` exactly like a folder is.
        // Folders first, so a shared name resolves to the folder — which is what a plan that says
        // „verschieben" meant.
        for (const label of account.labels) {
            if (!folderIds.has(label.Name)) {
                folderIds.set(label.Name, label.ID);
            }
        }
        // Proton's categories, so a category move can be verified by looking, exactly like a folder
        // move: the plan says „Transaktionen", Proton answers with label 26, and this is where the
        // two are allowed to meet. Without it every category move would report itself unconfirmed.
        for (const [id, name] of Object.entries(CATEGORY_LABELS)) {
            folderIds.set(name, id);
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
    // Last, because a folder that was not created is a bigger finding than a backlog that was not
    // re-sorted, and only one of them can be the headline.
    partial ??= backlogProblem;

    // A rewind that stopped is a real state and gets said, not rounded up. The steps that landed
    // are each their own journal entry, so the account is explicable from the record either way.
    if (performed.rewind?.stoppedAt !== undefined) {
        const landed = performed.rewind.steps.length;
        partial = new AppError('APPLY_PARTIAL', {
            message: `${String(landed)} Schritte zurückgenommen, dann abgebrochen.`,
            hint:
                'Der Rest steht noch. Es wurde nichts wieder vorgespult — das wäre eine zweite ' +
                'unbeaufsichtigte Schreibserie im Fehlerpfad. Der Verlauf zeigt, wo es endete.',
            context: { landed, stoppedAt: performed.rewind.stoppedAt },
        });
    }

    if (performed.rewrittenRules !== undefined && performed.rewrittenRules.length > 0) {
        log.info(
            { rules: performed.rewrittenRules.map((rule) => rule.name) },
            'rules repointed at the renamed folder'
        );
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

    return {
        entry,
        backupPath: saved.path,
        partial,
        adoptedFilterIds: [
            ...(performed.filterId === undefined ? [] : [performed.filterId]),
            ...(performed.adoptedFilterIds ?? []),
        ],
    };
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

    if (request.change.kind === 'delete-folder' || request.change.kind === 'rename-folder') {
        const name = request.change.folder?.name;
        if (name !== undefined && !account.folders.some((folder) => folder.Name === name)) {
            throw new AppError('APPLY_STATE_STALE', {
                message: `Den Ordner „${name}" gibt es bei Proton nicht mehr.`,
                hint: 'Es wurde nichts geschrieben. Neu synchronisieren.',
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

    if (request.change.kind === 'move-to-category') {
        const category = request.change.category;
        if (category === undefined || category.messageIds.length === 0) {
            throw new AppError('APPLY_MALFORMED', {
                message: 'Die Änderung sagt nicht, welche Mails wohin verschoben werden sollen.',
                hint: 'Es wurde nichts geschrieben. Ein Verschieben ohne Kennungen gibt es hier nicht.',
                context: { kind: request.change.kind },
            });
        }
        if (!(category.id in CATEGORY_LABELS)) {
            throw new AppError('APPLY_MALFORMED', {
                message: `„${category.id}" ist keine von Protons Kategorien.`,
                hint: 'Es wurde nichts geschrieben.',
                context: { categoryId: category.id },
            });
        }
        // The ids the terminal asked about must be the ids that move. If the two ever came apart,
        // the confirmation would cover one set of mail and the request would carry another.
        const asked = new Set(request.affectedMessageIds);
        const extra = category.messageIds.filter((id) => !asked.has(id));
        if (extra.length > 0) {
            throw new AppError('APPLY_MALFORMED', {
                message: 'Die Änderung nennt Mails, die im Diff nicht standen.',
                hint: 'Es wurde nichts geschrieben.',
                context: { kind: request.change.kind, extra: extra.length },
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
    /** Rules repointed by a rename, so the report can say the change reached further than one folder. */
    rewrittenRules?: Array<{ id: string; name: string }>;
    /** Rules the user just took responsibility for. Nothing was written for these. */
    adoptedFilterIds?: string[];
    /** What an undo actually put back, as observed rather than as intended. */
    undo?: { restored: number; skipped: number; unrestorable: number };
    /** Which steps of a rewind landed, and where it stopped if it did. */
    rewind?: { steps: Array<{ entryId: string; restored: number }>; stoppedAt?: string | undefined };
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
async function perform(
    request: ChangeRequest,
    account: Account,
    http: ProtonHttp,
    context: ApplyContext
): Promise<Performed> {
    const performed: Performed = { folders: [], filterId: undefined, problem: undefined };
    const change = request.change;
    const moveToCategory = context.moveToCategory;

    // A rule's target folder, created first if it is not there yet. This is also the only path by
    // which a folder typed into the rule editor comes into existence, which is deliberate: naming a
    // folder in a rule *is* asking for it.
    const target = change.after?.rule.Actions.FileInto.at(-1);
    if (target !== undefined && target !== '') {
        // Folder or label, as the change says. Proton's filter model cannot tell them apart — the
        // name goes into `FileInto` either way — so the intention has to travel with the change or
        // a rule meant to mark would create a folder and move the mail out of the inbox.
        const folder = await ensureFolder(http, account, target, undefined, change.targetKind ?? 'folder');
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

            /*
             * The folder-only changes.
             *
             * These used to fall through to the "not supported yet" branch below — except
             * `create-folder`, which fell through the *exception* to it and so reported success
             * without a request ever being made. A folder appeared in the dashboard and not in the
             * account, which is the worst of the three possible outcomes: it is the one nobody
             * checks.
             */
            case 'create-folder': {
                const name = folderName(change);
                const folder = await ensureFolder(http, account, name, change.folder?.parent);
                if (folder.created) {
                    performed.folders.push({ name, id: folder.id });
                }
                break;
            }

            case 'rename-folder': {
                const from = folderName(change);
                const to = change.folder?.newName?.trim() ?? '';
                if (to === '') {
                    throw new AppError('APPLY_MALFORMED', {
                        message: 'Für das Umbenennen fehlt der neue Name.',
                        hint: 'Es wurde nichts geschrieben.',
                        context: { folder: from },
                    });
                }
                await renameFolder(http, account, from, to);
                // The folder is renamed; every rule naming it still says the old name and would
                // file into nothing. Proton does not check this and does not warn about it.
                performed.rewrittenRules = await rewriteTargets(http, account, from, to);
                break;
            }

            case 'delete-folder': {
                const name = folderName(change);
                await removeFolder(http, account, name);
                break;
            }

            /*
             * Adopting writes nothing.
             *
             * It records that the user has taken responsibility for a rule Proton already runs. The
             * account is not touched — which is exactly why it must still come through here: the
             * decision goes into the journal beside the ones that did write, and the diff has
             * already shown what the rule does.
             */
            case 'adopt-rule':
                performed.adoptedFilterIds = change.before === undefined ? [] : [change.before.id];
                break;

            /*
             * The one change that moves mail.
             *
             * It is performed through a function handed in from outside rather than imported: this
             * file may not reach the message-moving module, and neither may `steps.ts`. A missing
             * one is refused loudly — the alternative is the failure this switch was rebuilt to
             * prevent, where a change reports success and nothing was ever sent.
             */
            case 'move-to-category': {
                const category = change.category;
                if (category === undefined) {
                    throw new AppError('APPLY_MALFORMED', {
                        message: 'Die Änderung nennt keine Kategorie und keine Mails.',
                        hint: 'Es wurde nichts geschrieben.',
                        context: { kind: change.kind },
                    });
                }
                if (moveToCategory === undefined) {
                    throw new AppError('APPLY_PARTIAL', {
                        message: 'Das Verschieben in eine Kategorie ist hier nicht verdrahtet.',
                        hint:
                            'Es wurde nichts geschrieben. Das passiert, wenn die Änderung nicht über ' +
                            '`pnpm serve` läuft — nur dort wird der Weg dafür bereitgestellt.',
                        context: { kind: change.kind },
                    });
                }
                await moveToCategory(category.messageIds, category.id);
                break;
            }

            /*
             * Taking a recorded change back — the rules here, the mail through the injected
             * service.
             *
             * The order inside `undoChange` is the one that matters and it is not ours to change:
             * the rule comes back first, because the filter is still running and mail moved back
             * under a live rule is re-filed within the hour. `performInverse` is this file's own
             * write path, handed over so the record's inverse goes through exactly the same
             * refusals, the same folder-before-filter ordering and the same reporting as any other
             * change.
             */
            case 'undo-entry': {
                const entryId = change.undo?.entryId;
                if (entryId === undefined) {
                    throw new AppError('APPLY_MALFORMED', {
                        message: 'Die Änderung sagt nicht, welcher Eintrag zurückgenommen werden soll.',
                        hint:
                            'Es wurde nichts geschrieben. Ein Rückgängig eines Rückgängig gibt es ' +
                            'nicht — die ursprüngliche Änderung lässt sich stattdessen neu machen.',
                        context: { kind: change.kind },
                    });
                }
                if (context.undoEntry === undefined) {
                    throw new AppError('APPLY_PARTIAL', {
                        message: 'Das Zurücknehmen ist hier nicht verdrahtet.',
                        hint:
                            'Es wurde nichts geschrieben. Das passiert, wenn die Änderung nicht über ' +
                            '`pnpm serve` läuft — nur dort liegt der Verlauf, aus dem ein Undo liest.',
                        context: { kind: change.kind },
                    });
                }
                const result = await context.undoEntry(entryId, async (inverse) => {
                    await perform(
                        { ...request, change: inverse },
                        account,
                        http,
                        // No nesting: an inverse is an ordinary change, and an inverse that is
                        // itself an undo is refused above rather than recursed into.
                        withoutUndo(context)
                    );
                });
                performed.undo = result;
                break;
            }

            /*
             * The same act, several times, newest first — and stopping at the first failure.
             *
             * A partly-rewound account is a state somebody has to be able to look at and
             * understand. Pressing on past an error would make it one nobody could describe, and
             * nothing here rolls forward again afterwards: that would be a second unwatched write
             * series inside an error path.
             */
            case 'rewind-to': {
                const entryId = change.undo?.entryId;
                if (entryId === undefined || entryId === '') {
                    throw new AppError('APPLY_MALFORMED', {
                        message: 'Die Änderung sagt nicht, bis wohin zurückgegangen werden soll.',
                        hint: 'Es wurde nichts geschrieben.',
                        context: { kind: change.kind },
                    });
                }
                if (context.rewindTo === undefined) {
                    throw new AppError('APPLY_PARTIAL', {
                        message: 'Das Zurückspulen ist hier nicht verdrahtet.',
                        hint:
                            'Es wurde nichts geschrieben. Das passiert, wenn die Änderung nicht über ' +
                            '`pnpm serve` läuft — nur dort liegt der Verlauf.',
                        context: { kind: change.kind },
                    });
                }
                const result = await context.rewindTo(entryId, async (inverse) => {
                    await perform({ ...request, change: inverse }, account, http, withoutUndo(context));
                });
                performed.rewind = result;
                break;
            }

            default: {
                // Every kind is handled above. This stays so that adding one to `ChangeKind`
                // without adding it here fails loudly instead of reporting a success nobody made.
                const unhandled: never = change.kind;
                throw new AppError('APPLY_PARTIAL', {
                    message: `„${String(unhandled)}" kann noch nicht auf das Konto geschrieben werden.`,
                    hint: 'Es wurde nichts weiter geschrieben.',
                    context: { kind: String(unhandled) },
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

/** The same capabilities minus the undo one, so an inverse cannot recurse into another undo. */
function withoutUndo(context: ApplyContext): ApplyContext {
    const { undoEntry: _undoEntry, rewindTo: _rewindTo, ...rest } = context;
    return rest;
}

/** The folder a folder-change names, or a refusal rather than a request against `undefined`. */
function folderName(change: PendingChange): string {
    const name = change.folder?.name?.trim() ?? '';
    if (name === '') {
        throw new AppError('APPLY_MALFORMED', {
            message: 'Die Änderung nennt keinen Ordner.',
            hint: 'Es wurde nichts geschrieben.',
            context: { kind: change.kind },
        });
    }
    return name;
}

/**
 * Point every rule that filed into `from` at `to`.
 *
 * Part of the rename, not a courtesy. Proton stores the destination as a name, so a renamed folder
 * leaves each rule filing into a name that no longer resolves — the rule still runs, the mail still
 * leaves the inbox, and it arrives nowhere. The count is reported so the change says how far it
 * reached rather than implying it was only one folder.
 */
async function rewriteTargets(
    http: ProtonHttp,
    account: Account,
    from: string,
    to: string
): Promise<Array<{ id: string; name: string }>> {
    const rewritten: Array<{ id: string; name: string }> = [];

    for (const filter of account.filters) {
        const simple = filter.Simple;
        if (simple === undefined || !simple.Actions.FileInto.includes(from)) {
            continue;
        }
        // Proton's stored `Simple` is validated structurally rather than against the compiler's
        // enums, so the cast is where the two meet. Only the destination string changes.
        const next = {
            ...simple,
            Actions: {
                ...simple.Actions,
                FileInto: simple.Actions.FileInto.map((entry) => (entry === from ? to : entry)),
            },
        } as unknown as SimpleObject;
        await writeFilter(http, {
            id: filter.ID,
            name: filter.Name,
            rule: next,
            enabled: filter.Status === 1,
        });
        rewritten.push({ id: filter.ID, name: filter.Name });
    }

    return rewritten;
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
