import { stdin, stdout } from 'node:process';

/**
 * Terminal prompts.
 *
 * The spike is run by the account owner in their own terminal. Credentials are typed here, used for
 * the SRP handshake, and never written anywhere — not to a file, not to the log, not to a fixture.
 *
 * This reads the input stream directly instead of using `readline`, after two failures that both
 * mattered:
 *
 *  1. Creating a `readline` interface per question and closing it ends the shared stdin, so the
 *     *second* prompt returned an empty string without ever appearing. That silently skipped the
 *     password prompt and sent an empty password to Proton, burning a login attempt.
 *  2. The usual way to hide typed input is to override readline's `_writeToOutput`. Node 24 no
 *     longer has it, so masking would simply not have happened — and the failure mode of a masking
 *     trick is a password printed in plain text.
 *
 * Reading raw has neither problem: one input path, no internals, and echo is something we perform
 * rather than something we suppress. The reader takes its streams as arguments so the behaviour can
 * be tested rather than trusted; `prompt.test.ts` drives it with in-memory streams.
 */

const CTRL_C = '';
const CTRL_D = '';
const BACKSPACE = '';
const BACKSPACE_ALT = '\b';

export type InputStream = NodeJS.ReadableStream & {
    isTTY?: boolean | undefined;
    setRawMode?(mode: boolean): unknown;
};

export interface OutputStream {
    write(chunk: string): unknown;
}

export interface PromptReaderOptions {
    input: InputStream;
    output: OutputStream;
    /** Called on Ctrl+C. Defaults to terminating the process, as a terminal program should. */
    onInterrupt?: () => void;
}

interface Waiter {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    echo: boolean;
}

export interface PromptReader {
    ask(question: string): Promise<string>;
    /** Same as `ask`, but nothing is echoed while typing. */
    askSecret(question: string): Promise<string>;
    askRequired(question: string, label: string): Promise<string>;
    askRequiredSecret(question: string, label: string): Promise<string>;
    close(): void;
}

export function createPromptReader(options: PromptReaderOptions): PromptReader {
    const { input, output } = options;
    const onInterrupt =
        options.onInterrupt ??
        ((): void => {
            process.exit(130);
        });

    /** Read from the stream but not yet consumed by a prompt — a pipe delivers everything at once. */
    let queue = '';
    let current = '';
    /**
     * Queued rather than a single slot: prompts are normally awaited one at a time, but issuing two
     * without awaiting used to overwrite the first, which then never resolved. Queuing turns a
     * silent hang into correct behaviour.
     */
    const waiters: Waiter[] = [];
    let listening = false;

    const onData = (chunk: string): void => {
        queue += chunk;
        drain();
    };

    const onEnd = (): void => {
        while (waiters.length > 0) {
            waiters.shift()?.reject(new Error('Eingabe wurde unerwartet beendet.'));
        }
    };

    function start(): void {
        if (listening) {
            return;
        }
        listening = true;
        if (input.isTTY === true) {
            input.setRawMode?.(true);
        }
        input.setEncoding('utf8');
        input.resume();
        input.on('data', onData);
        input.on('end', onEnd);
    }

    function close(): void {
        if (!listening) {
            return;
        }
        listening = false;
        input.off('data', onData);
        input.off('end', onEnd);
        if (input.isTTY === true) {
            input.setRawMode?.(false);
        }
        input.pause();
    }

    function drain(): void {
        while (waiters.length > 0 && queue.length > 0) {
            const waiter = waiters[0] as Waiter;
            const char = queue[0] as string;
            queue = queue.slice(1);

            if (char === CTRL_C) {
                output.write('^C\n');
                close();
                onInterrupt();
                return;
            }

            if (char === '\n' || char === '\r') {
                // A pipe sends "\r\n"; drop the partner so it does not open the next line.
                if (char === '\r' && queue.startsWith('\n')) {
                    queue = queue.slice(1);
                }
                output.write('\n');
                const line = current;
                current = '';
                waiters.shift()?.resolve(line);
                continue;
            }

            if (char === CTRL_D) {
                waiters.shift()?.reject(new Error('Eingabe abgebrochen.'));
                continue;
            }

            if (char === BACKSPACE || char === BACKSPACE_ALT) {
                if (current.length > 0) {
                    current = current.slice(0, -1);
                    if (waiter.echo) {
                        // Back up, overwrite with a space, back up again.
                        output.write('\b \b');
                    }
                }
                continue;
            }

            // Other control characters (arrow keys arrive as escape sequences) have no meaning here,
            // and letting them into a password would be worse than dropping them.
            if (char < ' ') {
                continue;
            }

            current += char;
            if (waiter.echo) {
                output.write(char);
            }
        }
    }

    function readLine(question: string, echo: boolean): Promise<string> {
        start();
        output.write(question);
        return new Promise<string>((resolve, reject) => {
            waiters.push({ resolve, reject, echo });
            // Input may already be buffered — a pipe, or typing ahead between prompts.
            drain();
        });
    }

    const ask = async (question: string): Promise<string> => (await readLine(question, true)).trim();
    const askSecret = async (question: string): Promise<string> => (await readLine(question, false)).trim();

    return {
        ask,
        askSecret,
        askRequired: async (question, label) => requireNonEmpty(await ask(question), label),
        askRequiredSecret: async (question, label) => requireNonEmpty(await askSecret(question), label),
        close,
    };
}

/**
 * Guard against sending an empty credential to Proton.
 *
 * Not defensive padding: the prompt bug above did exactly that. An empty password is worse than
 * useless — it burns a failed login attempt against the account's rate limit and comes back as a
 * generic authentication error that says nothing about the real cause.
 */
export function requireNonEmpty(value: string, label: string): string {
    if (value.trim() === '') {
        throw new Error(`${label} darf nicht leer sein — es wurde nichts eingegeben.`);
    }
    return value;
}

/** The reader bound to the real terminal. */
export const terminal = createPromptReader({ input: stdin, output: stdout });
