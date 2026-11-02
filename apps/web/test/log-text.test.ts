import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeEvent } from '../src/log-text.js';
import type { LogEntry } from '../src/log.js';

/**
 * Every event this application can log has a sentence.
 *
 * The screen used to show the event key and its context verbatim — `apply.applied`, `partial=false`
 * — which is the right record for a bug report and the wrong thing to put in front of somebody
 * asking whether their rule was saved. „partial=false" is a double negative pretending to be data.
 *
 * The list is read out of the source rather than typed here, so an event added next month is caught
 * by this test on the day it is added rather than showing up as a bare key on the screen.
 */

const SRC = join(import.meta.dirname, '..', 'src');

function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory()
            ? sources(path)
            : /\.tsx?$/.test(name)
              ? [path]
              : [];
    });
}

/** Every `log('info' | 'warn' | 'error', 'some.event', …)` the application makes. */
function loggedEvents(): string[] {
    const found = new Set<string>();
    for (const file of sources(SRC)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/\blog\(\s*'(?:info|warn|error)'\s*,\s*'([\w.-]+)'/g)) {
            found.add(match[1] as string);
        }
        // The one call that picks its key with a conditional rather than a literal.
        for (const match of text.matchAll(/\?\s*'([\w.-]+)'\s*:\s*'([\w.-]+)'\s*,\s*\{/g)) {
            if ((match[1] as string).includes('.')) {
                found.add(match[1] as string);
                found.add(match[2] as string);
            }
        }
    }
    return [...found].sort();
}

function entry(event: string, context: LogEntry['context'] = {}): LogEntry {
    return { at: 0, level: 'info', event, context };
}

describe('what the log says', () => {
    const events = loggedEvents();

    it('finds the events by reading the source, or it is testing nothing', () => {
        expect(events.length).toBeGreaterThan(10);
        expect(events).toContain('apply.applied');
    });

    it.each(loggedEvents())('says something other than the key for %s', (event) => {
        const sentence = describeEvent(entry(event));

        expect(sentence).not.toBe(event);
        // A sentence, not a fragment: it is read on its own in a table row.
        expect(sentence.length).toBeGreaterThan(12);
    });

    it('falls back to the key for an event it does not know', () => {
        // Visibly missing rather than silently blank. A row that said nothing would read as a
        // thing that did not happen.
        expect(describeEvent(entry('etwas.neues'))).toBe('etwas.neues');
    });

    it('answers „was everything written" instead of printing partial=false', () => {
        expect(describeEvent(entry('apply.applied', { partial: false }))).toBe(
            'Änderung bei Proton gespeichert.'
        );
        expect(describeEvent(entry('apply.applied', { partial: true }))).toContain(
            'nicht vollständig'
        );
    });

    it('counts in words that agree with the number', () => {
        expect(describeEvent(entry('sync.finished', { messages: 1, truncated: false }))).toContain(
            '1 Mail geholt'
        );
        expect(describeEvent(entry('sync.finished', { messages: 12, truncated: false }))).toContain(
            '12 Mails geholt'
        );
    });

    it('says what an incomplete sync means, not that it was truncated', () => {
        expect(describeEvent(entry('sync.finished', { messages: 20, truncated: true }))).toContain(
            'die Kopie ist unvollständig'
        );
    });
});
