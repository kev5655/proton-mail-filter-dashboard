import { createInterface } from 'node:readline';

import { describeChange, describePlan } from '@pms/changes';

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
    /**
     * Whether there is somebody at a keyboard.
     *
     * Defaults to what the input stream says. Set it in tests, where an injected stream is a real
     * answer channel and has no `isTTY` to report.
     */
    interactive?: boolean;
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
            `  ${describeChange(request.change)}`,
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

        const input = options.input ?? process.stdin;
        const interactive = options.interactive ?? (input as NodeJS.ReadStream).isTTY === true;

        /*
         * No terminal means no, and it means it now.
         *
         * `rl.question` on a stream nobody is typing into simply never calls back. The offer then
         * sat here for the full two minutes and came back „expired", which reads as „you were too
         * slow" — for a server that never had a keyboard to be slow at. Under systemd, in a
         * container, over a pipe, that made every category move, every undo and every large change
         * fail after a silent two-minute stall, with nothing on screen saying why.
         *
         * The refusal is written to the output as well as returned, because in exactly the
         * situation this catches, the output is a log file and it is the only place anybody will
         * look.
         */
        if (!interactive) {
            out.write(
                '  Kein Terminal — hier kann niemand antworten, also gilt die Änderung als abgelehnt.\n' +
                    '  Geschrieben wurde nichts. Diese Bestätigung braucht die Konsole, in der „pnpm serve" läuft.\n\n'
            );
            return 'declined';
        }

        const rl = createInterface({ input, output: out });

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
