import type { LabelProposal, LabelRequest } from './provider.js';

/**
 * Asking a model which labels fit, and refusing to let it answer with anything else.
 *
 * The rule Kevin set, and the reason for it: **choose from what exists; invent only when nothing
 * fits, and only when asked.** A model told to "suggest labels" invents one every time, and a
 * mailbox grows a dozen near-synonyms — „Rechnung", „Rechnungen", „Belege", „Buchhaltung" — each
 * with its own rule, none of them wrong and all of them noise. Nothing about that is the model
 * being bad at its job; it is the wrong question.
 *
 * So the existing labels always go with the request, and the answer is split in two on the way
 * back. Everything the model names that already exists is a choice. Everything else is an
 * invention, separated out, and dropped entirely unless new labels were explicitly allowed. That
 * check is here rather than in the prompt: a prompt is a request, and this is a guarantee.
 */

export function buildLabelPrompt(input: LabelRequest): string {
    const labels = input.existingLabels.length === 0 ? '(keine)' : input.existingLabels.join('\n- ');

    return [
        'Du hilfst beim Einordnen von E-Mails. Antworte ausschliesslich mit JSON.',
        '',
        'Vorhandene Labels dieses Postfachs:',
        `- ${labels}`,
        '',
        'Betreffzeilen:',
        ...input.subjects.slice(0, 20).map((subject) => `- ${subject}`),
        '',
        'Absender:',
        ...[...new Set(input.senders)].slice(0, 10).map((sender) => `- ${sender}`),
        '',
        'Aufgabe: Wähle aus den vorhandenen Labels diejenigen, die zu dieser Mail passen.',
        'Wähle lieber keines als ein unpassendes. Mehrere sind erlaubt.',
        input.allowNew
            ? 'Nur wenn wirklich keines passt, darfst du zusätzlich ein neues vorschlagen — höchstens eines.'
            : 'Erfinde keine neuen Labels. Wenn keines passt, gib eine leere Liste zurück.',
        '',
        'Format: {"chosen": ["..."], "proposedNew": ["..."], "rationale": "ein Satz"}',
    ].join('\n');
}

/**
 * Split what came back into what exists and what does not.
 *
 * Matched case-insensitively against the account's own labels, because a model that answers
 * „rechnungen" for a label called „Rechnungen" means the existing one — treating that as an
 * invention would create a second label differing only in case, which is the exact outcome this
 * whole design is trying to avoid.
 *
 * Anything unmatched is an invention and is dropped unless new labels were allowed. The model does
 * not get to widen its own permission by answering confidently.
 */
export function validateLabelProposal(raw: unknown, input: LabelRequest): LabelProposal {
    const value = raw as { chosen?: unknown; proposedNew?: unknown; rationale?: unknown };
    const named = [...asStrings(value.chosen), ...asStrings(value.proposedNew)];

    const existing = new Map(input.existingLabels.map((label) => [label.toLowerCase(), label]));
    const chosen: string[] = [];
    const proposedNew: string[] = [];

    for (const candidate of named) {
        const match = existing.get(candidate.toLowerCase());
        if (match !== undefined) {
            if (!chosen.includes(match)) {
                chosen.push(match);
            }
        } else if (input.allowNew && !proposedNew.includes(candidate)) {
            proposedNew.push(candidate);
        }
    }

    return {
        chosen,
        // At most one, however many came back. A model that returns five new labels has not
        // understood the question, and acting on all five would multiply the problem.
        proposedNew: proposedNew.slice(0, 1),
        rationale: typeof value.rationale === 'string' ? value.rationale.slice(0, 300) : '',
    };
}

function asStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '' && entry.length <= 60);
}
