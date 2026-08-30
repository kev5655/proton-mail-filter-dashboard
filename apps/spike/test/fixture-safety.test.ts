import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Nothing personal reaches a committed fixture.
 *
 * The scrubber already tries to guarantee this, and it failed: one substring test let whole Sieve
 * scripts through, and a real filter's sender fragments and folder name were committed and pushed
 * to a public repository. A guarantee that is only checked at the point of writing is checked in
 * the one place a bug can hide.
 *
 * So this looks at the files themselves, on the way in. It knows nothing about how they were made.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', 'fixtures', 'recorded');

const PSEUDONYM = /^s:[0-9a-f]{8}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Documented as Proton's or the format's, and checked against upstream where possible. */
const STRUCTURAL = new Set([
    'i;octet',
    'i;ascii-casemap',
    'i;ascii-numeric',
    'i;unicode-casemap',
    'From',
    'To',
    'Cc',
    'Bcc',
    'Subject',
    'vnd.proton.spam-threshold',
    'include',
    'environment',
    'variables',
    'relational',
    'comparator-i;ascii-numeric',
    'spamtest',
    'fileinto',
    'imap4flags',
    'vacation',
    'ge',
    'le',
    '*',
    '${1}',
]);

async function recordedFiles(): Promise<string[]> {
    try {
        const entries = await readdir(FIXTURES);
        return entries.filter((name) => name.endsWith('.json')).map((name) => join(FIXTURES, name));
    } catch {
        return [];
    }
}

/** Every string a Sieve script quotes. */
function literalsIn(script: string): string[] {
    return [...script.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

function sieveScripts(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) {
        value.forEach((item) => sieveScripts(item, found));
    } else if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
            if (key === 'Sieve' && typeof nested === 'string') {
                found.push(nested);
            } else {
                sieveScripts(nested, found);
            }
        }
    }
    return found;
}

describe('recorded fixtures are safe to publish', () => {
    it('contain no mail address', async () => {
        for (const file of await recordedFiles()) {
            const content = await readFile(file, 'utf8');
            expect(EMAIL.exec(content), `${file} contains a mail address`).toBeNull();
        }
    });

    it('quote nothing in a Sieve script but pseudonyms and the format itself', async () => {
        // The exact hole that leaked: the script was treated as one opaque value and skipped.
        for (const file of await recordedFiles()) {
            const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));

            for (const script of sieveScripts(parsed)) {
                for (const literal of literalsIn(script)) {
                    if (literal === '' || STRUCTURAL.has(literal) || PSEUDONYM.test(literal)) {
                        continue;
                    }
                    expect.unreachable(
                        `${file}: the Sieve script quotes "${literal}", which is neither a pseudonym ` +
                            'nor part of the Sieve or Proton vocabulary. If it is a value from the ' +
                            'account, the scrubber let it through — do not commit this file.'
                    );
                }
            }
        }
    });
});
