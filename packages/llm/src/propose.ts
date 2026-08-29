/**
 * Asking the model for a rule.
 *
 * This is the one place a language model gets to influence what ends up in someone's mailbox, so
 * the boundary is drawn deliberately and narrowly.
 *
 * The model returns **criteria**, not a rule and not a verdict. It may say "sender ends with
 * @versandhaus.example". It may not say which messages that catches, and it may not hand back
 * anything that goes to Proton unexamined. Those criteria are validated against the small set of
 * fields and comparators Proton actually supports, compiled by our own compiler, and then run
 * through the local matcher so the user sees the real list of affected mail before deciding.
 *
 * The reason for the fuss: a model that suggests a folder name can be wrong and cost a rename. A
 * model trusted to say what a filter matches can be wrong and cost mail that nobody ever finds
 * again. The first is a preference, the second is data loss, and the difference is worth a layer of
 * validation.
 */

/** Exactly the fields Proton's clickable filters support. Anything else is rejected outright. */
export const PROPOSABLE_FIELDS = ['sender', 'subject', 'recipient', 'attachments'] as const;
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];

export const PROPOSABLE_COMPARATORS = ['contains', 'is', 'starts', 'ends', 'matches'] as const;
export type ProposableComparator = (typeof PROPOSABLE_COMPARATORS)[number];

export interface ProposedCriterion {
    field: ProposableField;
    comparator: ProposableComparator;
    values: string[];
}

export interface RuleProposal {
    criteria: ProposedCriterion[];
    /** 'all' or 'any'. */
    operator: 'all' | 'any';
    folder: string;
    /** One sentence: why these criteria, in the model's own words. */
    rationale: string;
}

export interface SelectionSummary {
    subjects: string[];
    senders: string[];
    /** What the user typed, e.g. "es könnte noch ähnliche Mails geben, suche danach". */
    instruction: string;
    existingFolders: string[];
}

/**
 * Validate a proposal before anything is built from it.
 *
 * Written as a rejection, not a repair. Silently correcting a malformed proposal would mean acting
 * on a guess about what the model meant, and the user would never see that it happened.
 */
export function validateProposal(value: unknown): RuleProposal {
    if (value === null || typeof value !== 'object') {
        throw new Error('Der Vorschlag ist kein Objekt.');
    }

    const candidate = value as Record<string, unknown>;

    const operator = candidate['operator'];
    if (operator !== 'all' && operator !== 'any') {
        throw new Error(`Unbekannte Verknüpfung: ${JSON.stringify(operator)}.`);
    }

    const folder = candidate['folder'];
    if (typeof folder !== 'string' || folder.trim() === '' || folder.includes('\n')) {
        throw new Error('Kein brauchbarer Ordnername im Vorschlag.');
    }

    const rawCriteria = candidate['criteria'];
    if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
        throw new Error('Der Vorschlag enthält keine Bedingungen.');
    }

    const criteria = rawCriteria.map((entry, index): ProposedCriterion => {
        if (entry === null || typeof entry !== 'object') {
            throw new Error(`Bedingung ${index + 1} ist kein Objekt.`);
        }
        const record = entry as Record<string, unknown>;

        const field = record['field'];
        if (!isField(field)) {
            throw new Error(
                `Bedingung ${index + 1}: „${String(field)}" ist kein Feld, das Proton filtern kann.`
            );
        }

        const comparator = record['comparator'];
        if (!isComparator(comparator)) {
            throw new Error(`Bedingung ${index + 1}: Vergleich „${String(comparator)}" gibt es nicht.`);
        }

        const values = record['values'];
        const cleaned =
            Array.isArray(values) ?
                values.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
            :   [];

        // Attachments is an existence test and legitimately carries no values; everything else
        // without a value would match nothing, or everything, depending on the comparator.
        if (cleaned.length === 0 && field !== 'attachments') {
            throw new Error(`Bedingung ${index + 1} hat keine Werte.`);
        }

        return { field, comparator, values: cleaned.map((item) => item.trim()) };
    });

    return {
        criteria,
        operator,
        folder: folder.trim(),
        rationale:
            typeof candidate['rationale'] === 'string' ? candidate['rationale'].trim() : 'Ohne Begründung.',
    };
}

function isField(value: unknown): value is ProposableField {
    return typeof value === 'string' && (PROPOSABLE_FIELDS as readonly string[]).includes(value);
}

function isComparator(value: unknown): value is ProposableComparator {
    return typeof value === 'string' && (PROPOSABLE_COMPARATORS as readonly string[]).includes(value);
}

/** The prompt, kept here so it can be read and criticised rather than buried in an adapter. */
export function buildProposalPrompt(selection: SelectionSummary): string {
    return [
        'Du hilfst beim Erstellen eines E-Mail-Filters für Proton Mail.',
        '',
        'Der Nutzer hat diese Mails ausgewählt:',
        ...selection.subjects.slice(0, 15).map((subject) => `- ${subject}`),
        '',
        `Absender: ${[...new Set(selection.senders)].slice(0, 10).join(', ')}`,
        '',
        selection.instruction === '' ? '' : `Zusätzliche Anweisung des Nutzers: ${selection.instruction}`,
        '',
        `Vorhandene Ordner: ${selection.existingFolders.join(', ')}`,
        '',
        'Schlage Filterbedingungen vor, die genau diese Art Mail treffen.',
        `Erlaubte Felder: ${PROPOSABLE_FIELDS.join(', ')}.`,
        `Erlaubte Vergleiche: ${PROPOSABLE_COMPARATORS.join(', ')}.`,
        'Sei eher zu eng als zu weit: eine Regel, die zu viel trifft, versteckt Mail, die gebraucht wird.',
        '',
        'Antworte ausschliesslich als JSON:',
        '{"operator":"all","criteria":[{"field":"sender","comparator":"ends","values":["@beispiel.ch"]}],',
        '"folder":"Name","rationale":"ein kurzer Satz auf Deutsch"}',
    ]
        .filter((line) => line !== '')
        .join('\n');
}
