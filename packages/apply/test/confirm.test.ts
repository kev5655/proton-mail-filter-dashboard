import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { ChangeRequest, ConfirmationOffer } from '../src/apply.js';
import { confirmAtTerminal } from '../src/confirm.js';

/**
 * The question at the terminal, and what it does when there is no terminal.
 *
 * This function had no test at all, which is how it kept a failure mode nobody had considered:
 * `rl.question` on a stream nobody types into never calls back, so an offer made on a machine with
 * no keyboard sat for the full two minutes and then reported „expired". That is the wrong word for
 * it — nobody was slow — and two minutes is a long time to say nothing at all.
 */

function offerFor(over: Partial<ChangeRequest> = {}): ConfirmationOffer {
    const request = {
        requestId: 'req-1',
        createdAt: 1_700_000_000,
        change: {
            id: 'c-1',
            kind: 'delete-folder',
            before: { ID: 'f-1', Name: 'Rechnungen', ParentID: null },
        },
        plan: {
            change: { id: 'c-1', kind: 'delete-folder' },
            moves: [],
            clearedFromInbox: 0,
            returnedToInbox: 0,
            takenFrom: [],
        },
        affectedMessageIds: [],
        applyToExisting: false,
        baseVersion: 'v1',
        ...over,
    } as unknown as ChangeRequest;

    return { request, shortDigest: 'a1b2c3', reason: 'Diese Änderung entfernt etwas.', place: 'terminal' };
}

/** Collects what was printed, so the refusal can be asserted where it actually lands: the log. */
function sink(): Writable & { text: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
        write(chunk: Buffer | string, _encoding, callback): void {
            chunks.push(String(chunk));
            callback();
        },
    }) as Writable & { text: () => string };
    stream.text = () => chunks.join('');
    return stream;
}

describe('when there is nobody at a keyboard', () => {
    it('refuses at once instead of waiting out the timeout', async () => {
        const output = sink();
        // The full two minutes. If the refusal ever goes back to waiting, this test does not fail
        // on a wrong value — it fails by running out of time, which is the failure itself.
        const confirm = confirmAtTerminal({ input: new PassThrough(), output, timeoutMs: 120_000 });

        const started = Date.now();
        const verdict = await confirm(offerFor());

        expect(verdict).toBe('declined');
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('says why, in the output, because that output is a log file', async () => {
        const output = sink();
        const confirm = confirmAtTerminal({ input: new PassThrough(), output, timeoutMs: 120_000 });

        await confirm(offerFor());

        expect(output.text()).toContain('Kein Terminal');
        expect(output.text()).toContain('Geschrieben wurde nichts');
    });

    it('still prints what was being asked, so the log says what was refused', async () => {
        const output = sink();
        const confirm = confirmAtTerminal({ input: new PassThrough(), output, timeoutMs: 120_000 });

        await confirm(offerFor());

        expect(output.text()).toContain('a1b2c3');
        expect(output.text()).toContain('Diese Änderung entfernt etwas.');
    });
});

describe('when somebody is', () => {
    async function answer(typed: string): Promise<string> {
        const input = new PassThrough();
        const confirm = confirmAtTerminal({ input, output: sink(), timeoutMs: 5_000, interactive: true });
        const verdict = confirm(offerFor());
        input.write(`${typed}\n`);
        return verdict;
    }

    it('grants on „ja"', async () => {
        expect(await answer('ja')).toBe('granted');
    });

    it('accepts it however it was typed', async () => {
        expect(await answer('  JA  ')).toBe('granted');
    });

    it('declines on anything else, including a bare return', async () => {
        expect(await answer('nein')).toBe('declined');
        expect(await answer('')).toBe('declined');
        // „j" is not „ja". A confirmation that accepts prefixes is one keystroke from an accident.
        expect(await answer('j')).toBe('declined');
    });

    it('expires when the answer never comes', async () => {
        const confirm = confirmAtTerminal({
            input: new PassThrough(),
            output: sink(),
            timeoutMs: 30,
            interactive: true,
        });

        expect(await confirm(offerFor())).toBe('expired');
    });
});
