import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';

/**
 * Terminal prompts.
 *
 * The spike is run by the account owner, in their own terminal. Credentials are typed here, used
 * for the SRP handshake, and never written anywhere — not to a file, not to the log, not to a
 * fixture.
 */

export async function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}

/** Same, but nothing is echoed while typing. */
export async function askSecret(question: string): Promise<string> {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    const asMutable = rl as unknown as { _writeToOutput?: (chunk: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);

    stdout.write(question);
    asMutable._writeToOutput = (chunk: string): void => {
        // Let control sequences (the newline on submit) through, swallow the characters.
        if (chunk.includes('\n') || chunk.includes('\r')) {
            stdout.write('\n');
        }
    };

    try {
        const answer = await rl.question('');
        return answer.trim();
    } finally {
        if (original !== undefined) {
            asMutable._writeToOutput = original;
        }
        rl.close();
    }
}
