import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createPromptReader, requireNonEmpty, type PromptReader } from '../src/prompt.js';

/**
 * This module has broken twice, both times silently, and once at real cost — an empty password was
 * sent to Proton and burned a login attempt against the account's rate limit.
 *
 * Both bugs shared a shape: the prompt appeared to work while doing nothing. So these tests assert
 * the two things that were actually wrong — that every prompt in a sequence really reads its own
 * value, and that a secret never reaches the output stream.
 */

function harness(): { reader: PromptReader; input: PassThrough; written: () => string } {
    const input = new PassThrough();
    const chunks: string[] = [];
    const reader = createPromptReader({
        input: input as never,
        output: { write: (chunk: string) => chunks.push(chunk) },
        onInterrupt: () => {
            throw new Error('interrupted');
        },
    });
    return { reader, input, written: () => chunks.join('') };
}

describe('prompt reader', () => {
    it('reads three consecutive prompts, each getting its own line', async () => {
        // The regression: a second prompt used to return '' immediately, unseen.
        const { reader, input } = harness();
        const pending = Promise.all([
            reader.ask('User: '),
            reader.askSecret('Pass: '),
            reader.askSecret('2FA: '),
        ]);
        input.write('kevin@example.com\nsuper-secret\n123456\n');

        expect(await pending).toEqual(['kevin@example.com', 'super-secret', '123456']);
        reader.close();
    });

    it('never writes a secret to the output', async () => {
        const { reader, input, written } = harness();
        const pending = reader.askSecret('Pass: ');
        input.write('hunter2\n');
        await pending;

        expect(written()).toContain('Pass: ');
        expect(written()).not.toContain('hunter2');
        expect(written()).not.toContain('hunter');
        reader.close();
    });

    it('echoes a non-secret answer, so the user can see what they typed', async () => {
        const { reader, input, written } = harness();
        const pending = reader.ask('User: ');
        input.write('kevin\n');
        await pending;

        expect(written()).toContain('kevin');
        reader.close();
    });

    it('handles input that arrives one character at a time', async () => {
        const { reader, input } = harness();
        const pending = reader.askSecret('Pass: ');
        for (const char of 'abc\n') {
            input.write(char);
        }

        expect(await pending).toBe('abc');
        reader.close();
    });

    it('handles a whole batch arriving before the prompt is even asked', async () => {
        // A pipe delivers everything at once, so the queue must survive between prompts.
        const { reader, input } = harness();
        input.write('one\ntwo\n');
        await new Promise((resolve) => setImmediate(resolve));

        expect(await reader.ask('A: ')).toBe('one');
        expect(await reader.ask('B: ')).toBe('two');
        reader.close();
    });

    it('applies backspace without leaking the deleted characters', async () => {
        const { reader, input, written } = harness();
        const pending = reader.askSecret('Pass: ');
        input.write('abXc\n');

        expect(await pending).toBe('abc');
        expect(written()).not.toContain('X');
        reader.close();
    });

    it('accepts CRLF line endings as one line break', async () => {
        const { reader, input } = harness();
        const pending = reader.ask('A: ');
        input.write('value\r\n');

        expect(await pending).toBe('value');
        reader.close();
    });

    it('drops stray control characters rather than putting them in a password', async () => {
        const { reader, input } = harness();
        const pending = reader.askSecret('Pass: ');
        input.write('pa[Ass\n');

        expect(await pending).toBe('pa[Ass'.replace('[A', '[A'));
        reader.close();
    });

    it('rejects when the stream ends mid-prompt instead of returning an empty answer', async () => {
        const { reader, input } = harness();
        const pending = reader.askSecret('Pass: ');
        input.end();

        await expect(pending).rejects.toThrow(/beendet/);
        reader.close();
    });

    it('reports an interrupt rather than continuing', async () => {
        const onInterrupt = vi.fn();
        const input = new PassThrough();
        const reader = createPromptReader({
            input: input as never,
            output: { write: () => undefined },
            onInterrupt,
        });
        void reader.askSecret('Pass: ');
        input.write('');
        await new Promise((resolve) => setImmediate(resolve));

        expect(onInterrupt).toHaveBeenCalledOnce();
    });
});

describe('requireNonEmpty', () => {
    it('rejects the empty answer that caused a failed login against Proton', () => {
        expect(() => requireNonEmpty('', 'Passwort')).toThrow(/darf nicht leer sein/);
        expect(() => requireNonEmpty('   ', 'Passwort')).toThrow(/darf nicht leer sein/);
    });

    it('passes a real value through untouched', () => {
        expect(requireNonEmpty('hunter2', 'Passwort')).toBe('hunter2');
    });
});
