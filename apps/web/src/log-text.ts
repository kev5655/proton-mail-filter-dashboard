import type { LogEntry } from './log.js';

/**
 * One log entry, as a sentence.
 *
 * The screen showed `apply.applied` and `partial=false`, which is the record the *report* needs —
 * an event key and a machine-readable context, greppable back to the line that wrote it — and is
 * not something to put in front of somebody who wants to know whether their rule was saved.
 * „partial=false" in particular is a double negative pretending to be data.
 *
 * So the two are separated rather than one being replaced. This produces the sentence, the entry
 * keeps its key, and `buildIncidentReport` still exports the keys untouched — a report that had
 * been prettified would be a report nobody could search.
 *
 * Anything unrecognised falls back to the key. A missing sentence must look like a missing
 * sentence, not like nothing happened.
 */
export function describeEvent(entry: LogEntry): string {
    const context = entry.context;
    const number = (key: string): number => (typeof context[key] === 'number' ? context[key] : 0);
    const flag = (key: string): boolean => context[key] === true;
    const text = (key: string): string => (typeof context[key] === 'string' ? context[key] : '');

    switch (entry.event) {
        case 'apply.offered':
            return number('moves') === 0
                ? 'Änderung an den Server übergeben — sie verschiebt keine Mail.'
                : `Änderung an den Server übergeben, ${plural(number('moves'), 'Mail betroffen', 'Mails betroffen')}.`;

        case 'apply.applied':
            // The one that read „partial=false". What matters is whether everything landed, and
            // the two answers deserve different sentences rather than a flag.
            return flag('partial')
                ? 'Änderung gespeichert — aber nicht vollständig. Die Einzelheiten stehen oben im Verlauf.'
                : 'Änderung bei Proton gespeichert.';

        case 'apply.failed':
            return `Änderung fehlgeschlagen, es wurde nichts geschrieben (Fehlercode ${text('code')}).`;

        case 'rule.stage-create':
            return `Neue Regel vorgemerkt, mit ${plural(number('conditions'), 'Bedingung', 'Bedingungen')}.`;

        case 'rule.stage-update':
            return `Regel geändert und vorgemerkt, mit ${plural(number('conditions'), 'Bedingung', 'Bedingungen')}.`;

        case 'rule.stage-delete':
            return 'Löschen einer Regel vorgemerkt.';

        case 'rule.stage-disable':
            return 'Abschalten einer Regel vorgemerkt.';

        case 'suggestion.stage':
            return `Vorschlag übernommen und als Regel vorgemerkt (${plural(number('size'), 'Mail', 'Mails')}).`;

        case 'folder.stage-create':
            return flag('nested')
                ? 'Neuen Unterordner vorgemerkt.'
                : 'Neuen Ordner vorgemerkt.';

        case 'folder.stage-rename':
            return number('rules') === 0
                ? 'Umbenennen eines Ordners vorgemerkt.'
                : `Umbenennen eines Ordners vorgemerkt — ${plural(number('rules'), 'Regel zeigt', 'Regeln zeigen')} darauf.`;

        case 'folder.stage-delete':
            return `Löschen eines Ordners vorgemerkt: ${plural(number('mails'), 'Mail liegt', 'Mails liegen')} darin, ${plural(number('rules'), 'Regel sortiert', 'Regeln sortieren')} dorthin.`;

        case 'sync.finished':
            return flag('truncated')
                ? `Synchronisation fertig, ${plural(number('messages'), 'Mail', 'Mails')} geholt — die Obergrenze war erreicht, die Kopie ist unvollständig.`
                : `Synchronisation fertig, ${plural(number('messages'), 'Mail', 'Mails')} geholt.`;

        case 'login.done':
            return 'Bei Proton angemeldet.';

        case 'login.failed':
            return `Anmeldung bei Proton fehlgeschlagen (Fehlercode ${text('code')}). Sie wird nicht automatisch wiederholt.`;

        case 'login.disconnected':
            return flag('revoked')
                ? 'Verbindung getrennt — die Sitzung wurde auch bei Proton beendet.'
                : 'Verbindung hier getrennt. Bei Proton läuft die Sitzung weiter.';

        case 'llm.unavailable':
            return `Das Sprachmodell ist nicht erreichbar (${text('mode')}). Alles andere funktioniert ohne es.`;

        case 'ui.crash':
            return `Ein Bildschirm ist abgestürzt${text('area') === '' ? '' : `: ${text('area')}`}. Der Rest läuft weiter.`;

        default:
            return entry.event;
    }
}

function plural(count: number, one: string, many: string): string {
    return `${String(count)} ${count === 1 ? one : many}`;
}
