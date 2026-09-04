import { createInterface } from 'node:readline';

import { describePlan } from '@pms/changes';

import type { ConfirmationOffer, ConfirmationVerdict } from './apply.js';

/**
 * Asking the person at the keyboard.
 *
 * This function is the whole guarantee. A request over HTTP is an offer; anything on this machine
 * can make one. The grant is a word typed at a terminal, which nothing on this machine can do —
 * and until it comes back, `applyChange` has not written and will not write.
 *
 * What is printed is derived from the request itself, never from a label the caller chose. A
 * malicious or mistaken offer therefore has to describe itself accurately in order to be approved,
 * and the digest lets the two ends be compared: the dashboard shows six characters beside "warte
 * auf Bestätigung", and so does this.
 *
 * `ja` in full rather than a keypress. Pressing return by reflex should not move anybody's mail.
 *
 * This is not asked for every change — see `weigh` in `apply.ts`. A dialog that appears for every
 * small rule becomes a reflex, and a confirmation people answer without reading protects nothing.
 * It is asked when the change resorts a large share of the mailbox, or removes something.
 */

export interface TerminalConfirmOptions {
    /** How long the offer stands. Long enough to read the diff, short enough not to linger. */
    timeoutMs?: number;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
}

export function confirmAtTerminal(
    options: TerminalConfirmOptions = {}
): (offer: ConfirmationOffer) => Promise<ConfirmationVerdict> {
    const timeoutMs = options.timeoutMs ?? 120_000;

    return async (offer: ConfirmationOffer) => {
        const { request } = offer;
        const plan = request.plan;
        const out = options.output ?? process.stdout;

        const lines = [
            '',
            '─────────────────────────────────────────────────────────────',
            '  Das Dashboard möchte etwas an deinem Proton-Konto ändern.',
            '',
            `  ${request.change.summary}`,
            '',
            `  ${offer.reason}`,
            '',
            `  ${describePlan(plan)}`,
            ...(plan.takenFrom.length === 0
                ? []
                : plan.takenFrom.map(
                      (taken) =>
                          // The thing most likely to be unintended, so it gets its own line.
                          `  ${taken.count} davon sortiert heute „${taken.ruleName}".`
                  )),
            '',
            request.applyToExisting
                ? `  Bestehende Mail wird mit einbezogen: ${String(request.affectedMessageIds.length)} Nachrichten.`
                : '  Nur künftige Mail. Am Bestand ändert sich nichts.',
            '',
            `  Prüfziffer: ${offer.shortDigest}  — dieselbe muss im Dashboard stehen.`,
            '',
            '  Vorher wird eine vollständige Sicherung aller Filter und Ordner angelegt.',
            '  Bis hierher wurde nichts geschrieben.',
            '─────────────────────────────────────────────────────────────',
            '',
        ];
        out.write(`${lines.join('\n')}\n`);

        const rl = createInterface({ input: options.input ?? process.stdin, output: out });

        try {
            const answer = await Promise.race([
                new Promise<string>((resolve) => {
                    rl.question('  Ausführen? Tippe „ja" zum Bestätigen: ', resolve);
                }),
                new Promise<'__timeout'>((resolve) => {
                    const timer = setTimeout(() => resolve('__timeout'), timeoutMs);
                    // Do not hold the process open just to expire an offer nobody is waiting on.
                    timer.unref?.();
                }),
            ]);

            if (answer === '__timeout') {
                out.write('\n  Abgelaufen — es wurde nichts geschrieben.\n\n');
                return 'expired';
            }

            const granted = answer.trim().toLowerCase() === 'ja';
            out.write(granted ? '\n  Bestätigt.\n\n' : '\n  Abgelehnt — es wurde nichts geschrieben.\n\n');
            return granted ? 'granted' : 'declined';
        } finally {
            rl.close();
        }
    };
}
