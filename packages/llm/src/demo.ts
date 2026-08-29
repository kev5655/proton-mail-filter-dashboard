import type { GroupSummary, LlmProvider, SieveExplanation, Suggestion } from './provider.js';
import { validateProposal, type RuleProposal, type SelectionSummary } from './propose.js';

/**
 * A stand-in model for the demo and for tests.
 *
 * Deterministic and obviously mechanical. It exists so the interface can be exercised end to end
 * without a model running, and so the screens can be looked at and judged before M3 wires up a real
 * one. Its answers go through exactly the same validation as a real model's, which is the part
 * worth testing: if this provider returned something malformed, it would be rejected too.
 */

const SIEVE_EXPLANATIONS: Array<{ match: RegExp; explanation: SieveExplanation }> = [
    {
        match: /spam-threshold/,
        explanation: {
            summary:
                'Das Skript überspringt Spam-verdächtige Mails und sortiert die übrigen nach Absender in einen Ordner.',
            steps: [
                'Zuerst wird geprüft, wie Proton die Mail auf Spam bewertet hat. Liegt sie über der eingestellten Schwelle, bricht das Skript ab und tut nichts.',
                'Danach wird der Absender geprüft. Passt er, wird die Mail in den angegebenen Ordner verschoben.',
            ],
        },
    },
];

const GENERIC_SIEVE: SieveExplanation = {
    summary: 'Ein selbst geschriebenes Sieve-Skript. Die abgeleitete Struktur darunter ist massgeblich.',
    steps: ['Ohne laufendes Sprachmodell gibt es hier keine ausführliche Erklärung.'],
};

export function createDemoProvider(): LlmProvider & {
    proposeRule(selection: SelectionSummary): Promise<RuleProposal>;
} {
    return {
        name: 'Demo-Modell (kein echtes LLM)',

        async isAvailable() {
            return true;
        },

        async suggestFolderName(group: GroupSummary, existingFolders: string[]): Promise<Suggestion> {
            const haystack = `${group.reason} ${group.sampleSubjects.join(' ')}`.toLowerCase();

            const matched = existingFolders.find((folder) => mentions(haystack, folder));
            if (matched !== undefined) {
                return { value: matched, rationale: `Der Ordner „${matched}" passt bereits zum Inhalt.` };
            }

            const organisation = group.senderDomain.split('.')[0] ?? 'Diverses';
            const name = organisation.charAt(0).toUpperCase() + organisation.slice(1);
            return { value: name, rationale: `Alle Mails dieser Gruppe kommen von ${group.senderDomain}.` };
        },

        async explainSieve(sieve: string): Promise<SieveExplanation> {
            return SIEVE_EXPLANATIONS.find((entry) => entry.match.test(sieve))?.explanation ?? GENERIC_SIEVE;
        },

        /**
         * Derive criteria from the selection the way a careful person would: what do these messages
         * share that nothing else does. The instruction is acknowledged rather than acted on — a
         * stand-in that pretended to understand free text would be the most misleading thing here.
         */
        async proposeRule(selection: SelectionSummary): Promise<RuleProposal> {
            const senders = [...new Set(selection.senders)];
            const domains = [...new Set(senders.map((address) => address.split('@')[1] ?? ''))].filter(
                (domain) => domain !== ''
            );

            const wantsWider = /ähnlich|aehnlich|weitere|mehr|suche/i.test(selection.instruction);

            const proposal =
                senders.length === 1 && !wantsWider ?
                    {
                        operator: 'all',
                        criteria: [{ field: 'sender', comparator: 'is', values: senders }],
                        folder: folderFor(selection, domains[0] ?? ''),
                        rationale: `Alle ausgewählten Mails kommen von ${senders[0]}.`,
                    }
                :   {
                        operator: 'all',
                        criteria: [
                            {
                                field: 'sender',
                                comparator: 'ends',
                                values: domains.flatMap((domain) => [`@${domain}`, `.${domain}`]),
                            },
                        ],
                        folder: folderFor(selection, domains[0] ?? ''),
                        rationale: wantsWider
                            ? `Bewusst weiter gefasst: alles von ${domains.join(', ')}, nicht nur die ausgewählten Absender.`
                            : `Die Auswahl umfasst mehrere Absender bei ${domains.join(', ')}.`,
                    };

            // Through the same gate a real model's answer goes through, so the demo cannot get away
            // with something the validator would reject.
            return validateProposal(proposal);
        },
    };
}

function folderFor(selection: SelectionSummary, domain: string): string {
    const haystack = `${selection.subjects.join(' ')} ${domain}`.toLowerCase();
    const existing = selection.existingFolders.find((folder) => mentions(haystack, folder));
    if (existing !== undefined) {
        return existing;
    }
    const organisation = domain.split('.')[0] ?? 'Diverses';
    return organisation === '' ? 'Diverses' : organisation.charAt(0).toUpperCase() + organisation.slice(1);
}

/**
 * Does the text plausibly refer to this folder?
 *
 * Crude on purpose. German folder names are usually the plural of the word that appears in a
 * subject line — "Rechnungen" for a mail saying "Ihre Rechnung 4711" — so a literal substring test
 * misses the obvious case. Chopping a few common endings off both sides catches it without pulling
 * in a stemmer, and this whole provider is a placeholder for a real model anyway.
 */
function mentions(haystack: string, folder: string): boolean {
    const words = haystack.split(/[^\p{L}]+/u).filter((word) => word.length >= 4);
    return folder
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((part) => part.length >= 4)
        .some((part) => words.some((word) => stem(word) === stem(part)));
}

function stem(word: string): string {
    return word.replace(/(ungen|ung|en|er|es|e|n|s)$/u, '');
}
