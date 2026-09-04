import { buildProposalPrompt, validateProposal, type RuleProposal, type SelectionSummary } from './propose.js';
import type { GroupSummary, LlmProvider, SieveExplanation, Suggestion } from './provider.js';

/**
 * Ollama, local or on a server.
 *
 * One adapter for both: the only difference is the base URL, so a model running on the desktop and
 * one running on a machine down the hall are the same thing to everything above this file.
 *
 * The prompts are deliberately narrow and the outputs are parsed strictly. A model asked an open
 * question returns prose that has to be interpreted, and interpreting model output is where a
 * folder suggestion quietly becomes a folder name with a newline in it.
 */

export interface OllamaConfig {
    /** e.g. `http://127.0.0.1:11434` locally, or a server on the network. */
    baseUrl: string;
    /**
     * The model name as Ollama knows it, e.g. `qwen2.5:7b`.
     *
     * Size it to the machine rather than to ambition: a 7–8B model quantised to Q4 needs roughly
     * 5 GB and runs acceptably on the CPU when it does not fit the card. A 12–14B wants about 12 GB
     * of VRAM, which most laptops do not have.
     */
    model: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

interface OllamaResponse {
    response?: string;
}

export function createOllamaProvider(config: OllamaConfig): LlmProvider {
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const timeoutMs = config.timeoutMs ?? 60_000;

    async function generate(prompt: string, format?: 'json'): Promise<string> {
        const response = await fetchImpl(`${config.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: config.model,
                prompt,
                stream: false,
                ...(format === undefined ? {} : { format }),
                // Low temperature: the same mailbox should not produce a different folder name on
                // every run, or the suggestion stops being something the user can learn to trust.
                options: { temperature: 0.2 },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            throw new Error(`Ollama antwortete mit HTTP ${response.status}.`);
        }

        const body = (await response.json()) as OllamaResponse;
        const text = body.response?.trim();
        if (text === undefined || text === '') {
            throw new Error('Ollama lieferte eine leere Antwort.');
        }
        return text;
    }

    return {
        name: `Ollama (${config.model})`,

        async isAvailable(): Promise<boolean> {
            try {
                const response = await fetchImpl(`${config.baseUrl}/api/tags`, {
                    signal: AbortSignal.timeout(3_000),
                });
                return response.ok;
            } catch {
                return false;
            }
        },

        async suggestFolderName(group: GroupSummary, existingFolders: string[]): Promise<Suggestion> {
            const raw = await generate(
                [
                    'Du hilfst beim Sortieren eines E-Mail-Postfachs.',
                    '',
                    `Gruppe: ${group.reason}`,
                    `Absender-Domäne: ${group.senderDomain}`,
                    `Kategorien: ${group.categories.join(', ') || 'keine'}`,
                    'Beispiel-Betreffzeilen:',
                    ...group.sampleSubjects.slice(0, 5).map((subject) => `- ${subject}`),
                    '',
                    `Vorhandene Ordner: ${existingFolders.join(', ')}`,
                    '',
                    'Schlage genau einen Zielordner vor. Bevorzuge einen vorhandenen Ordner, wenn er passt.',
                    'Antworte als JSON: {"folder": "...", "rationale": "ein kurzer Satz auf Deutsch"}',
                ].join('\n'),
                'json'
            );

            const parsed = JSON.parse(raw) as { folder?: unknown; rationale?: unknown };
            const folder = typeof parsed.folder === 'string' ? parsed.folder.trim() : '';
            if (folder === '' || folder.includes('\n')) {
                throw new Error('Ollama lieferte keinen brauchbaren Ordnernamen.');
            }

            return {
                value: folder,
                rationale:
                    typeof parsed.rationale === 'string' ? parsed.rationale.trim() : 'Ohne Begründung.',
            };
        },

        /**
         * Criteria for a rule, from a hand-picked set of mail.
         *
         * The prompt and the validator both already existed in `propose.ts` and are used verbatim.
         * That matters more than convenience: `validateProposal` rejects rather than repairs, so a
         * model naming a field Proton cannot filter on, or an empty value list, fails here instead
         * of becoming a rule that silently matches nothing.
         */
        async proposeRule(selection: SelectionSummary): Promise<RuleProposal> {
            const raw = await generate(buildProposalPrompt(selection), 'json');
            return validateProposal(JSON.parse(raw));
        },

        async explainSieve(sieve: string): Promise<SieveExplanation> {
            const raw = await generate(
                [
                    'Erkläre dieses Sieve-Filterskript aus Proton Mail in einfachem Deutsch.',
                    'Beschreibe nur, was dasteht. Rate nichts dazu.',
                    '',
                    '```',
                    sieve,
                    '```',
                    '',
                    'Antworte als JSON: {"summary": "ein Satz", "steps": ["...", "..."]}',
                ].join('\n'),
                'json'
            );

            const parsed = JSON.parse(raw) as { summary?: unknown; steps?: unknown };
            return {
                summary: typeof parsed.summary === 'string' ? parsed.summary : 'Keine Zusammenfassung.',
                steps: Array.isArray(parsed.steps)
                    ? parsed.steps.filter((step): step is string => typeof step === 'string')
                    : [],
            };
        },
    };
}
