import { getLogger } from '@pms/core/logger';

const log = getLogger('server');

/**
 * Offers waiting for a person.
 *
 * The dashboard posts a change; this records it and answers `202` with a reference. It does not
 * perform anything and cannot — the executor is handed in from outside, and the file that parses
 * the HTTP is forbidden from importing it. What actually applies the change is a word typed at the
 * terminal where `pnpm serve` runs, which nothing reachable over the network can do.
 *
 * One offer at a time. A queue would mean someone confirming while looking at the wrong one, and
 * the whole value of the confirmation is that it is attached to a specific change the person has
 * just read.
 */

export type OfferState =
    | { state: 'pending'; shortDigest: string; summary: string; since: number }
    | { state: 'applied'; summary: string; backupPath: string; partial?: string | undefined }
    | { state: 'failed'; summary: string; error: string; code?: string | undefined };

/** What the executor does with an offer. Anything Proton-shaped stays on the far side of this. */
export type OfferRunner = (request: unknown) => Promise<{ backupPath: string; partial?: string | undefined }>;

/**
 * What the offer step worked out about a change, before anybody was asked about it.
 *
 * `needsTerminal` travels back to the dashboard so it can stop claiming a terminal question that is
 * not coming. The rule that decides it lives in `@pms/apply`, which the browser may not import —
 * it pulls the Proton client with it — so the answer is computed here, where the decision is made
 * anyway, and carried in the `202`.
 */
export interface Described {
    id: string;
    summary: string;
    shortDigest: string;
    /** Whether a typed „ja" at the terminal is required for this particular change. */
    needsTerminal: boolean;
    /** Why, when it is. Empty otherwise. */
    reason: string;
}

export interface Offered {
    id: string;
    shortDigest: string;
    needsTerminal: boolean;
    reason: string;
}

export class ApplyChannel {
    #offers = new Map<string, OfferState>();
    #busy = false;
    readonly #run: OfferRunner | undefined;
    readonly #describe: (request: unknown) => Described | undefined;

    constructor(
        describe: (request: unknown) => Described | undefined,
        run?: OfferRunner
    ) {
        this.#describe = describe;
        this.#run = run;
    }

    get available(): boolean {
        return this.#run !== undefined;
    }

    stateOf(id: string): OfferState | undefined {
        return this.#offers.get(id);
    }

    /**
     * Take an offer, or say why not.
     *
     * Returns the reference the dashboard polls. The change is *not* applied when this returns —
     * that is the entire point, and the reason this method resolves immediately while the terminal
     * is still asking.
     */
    offer(request: unknown): Offered | { refused: string; code: string } {
        if (this.#run === undefined) {
            return {
                refused: 'Dieser Server kann nichts an Proton schreiben.',
                code: 'SERVER_APPLY_UNAVAILABLE',
            };
        }
        if (this.#busy) {
            return {
                refused: 'Es wartet bereits eine Änderung auf Bestätigung im Terminal.',
                code: 'APPLY_BUSY',
            };
        }

        const described = this.#describe(request);
        if (described === undefined) {
            return { refused: 'Die Änderung war nicht lesbar.', code: 'APPLY_MALFORMED' };
        }

        this.#busy = true;
        this.#offers.set(described.id, {
            state: 'pending',
            shortDigest: described.shortDigest,
            summary: described.summary,
            since: Date.now(),
        });

        const run = this.#run;
        void run(request)
            .then((result) => {
                this.#offers.set(described.id, {
                    state: 'applied',
                    summary: described.summary,
                    backupPath: result.backupPath,
                    ...(result.partial === undefined ? {} : { partial: result.partial }),
                });
                log.info({ id: described.id }, 'change applied');
            })
            .catch((cause: unknown) => {
                const error = cause instanceof Error ? cause.message : 'Unbekannter Fehler.';
                const code =
                    cause !== null && typeof cause === 'object' && 'code' in cause
                        ? String((cause as { code: unknown }).code)
                        : undefined;
                this.#offers.set(described.id, {
                    state: 'failed',
                    summary: described.summary,
                    error,
                    ...(code === undefined ? {} : { code }),
                });
                log.info({ id: described.id, code }, 'change not applied');
            })
            .finally(() => {
                this.#busy = false;
            });

        return {
            id: described.id,
            shortDigest: described.shortDigest,
            needsTerminal: described.needsTerminal,
            reason: described.reason,
        };
    }
}
