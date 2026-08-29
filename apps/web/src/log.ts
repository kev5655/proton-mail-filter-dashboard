/**
 * A log the user can hand over.
 *
 * The project's premise is that it will be developed further with an assistant, and the hardest
 * part of that is not fixing a fault but describing it. So the interface keeps a structured record
 * of what happened and can export it as text: error codes, the sequence of actions, and nothing
 * else.
 *
 * Nothing else, specifically: no subject lines, no addresses, no folder names. An incident report
 * is pasted into a chat window, and a report that has to be redacted first will not be sent.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
    at: number;
    level: LogLevel;
    /** What happened, as a short machine-readable key. */
    event: string;
    /** Counts and codes only. */
    context: Record<string, string | number | boolean>;
}

const MAX_ENTRIES = 500;

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

export function log(level: LogLevel, event: string, context: LogEntry['context'] = {}): void {
    entries.push({ at: Date.now(), level, event, context });
    if (entries.length > MAX_ENTRIES) {
        entries.shift();
    }
    for (const listener of listeners) {
        listener();
    }
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function snapshot(): LogEntry[] {
    return [...entries].reverse();
}

/** The text to paste into a bug report. */
export function buildIncidentReport(appVersion: string): string {
    const recent = snapshot().slice(0, 100).reverse();

    return [
        '# Proton Mail Sorter — Vorfallbericht',
        `Version: ${appVersion}`,
        `Erstellt: ${new Date().toISOString()}`,
        '',
        'Enthält Ereignisse, Fehlercodes und Zahlen. Keine Betreffzeilen, keine Adressen,',
        'keine Ordnernamen — der Bericht ist zum Weitergeben gedacht.',
        '',
        '## Ereignisse',
        ...recent.map(
            (entry) =>
                `${new Date(entry.at).toISOString()}  ${entry.level.toUpperCase().padEnd(5)} ${entry.event}` +
                (Object.keys(entry.context).length > 0 ? `  ${JSON.stringify(entry.context)}` : '')
        ),
    ].join('\n');
}
