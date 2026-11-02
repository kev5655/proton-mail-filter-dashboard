import { buildLabelPrompt, validateLabelProposal } from './labels.js';
import { buildProposalPrompt, validateProposal, type RuleProposal, type SelectionSummary } from './propose.js';
import type {
    GroupSummary,
    LabelProposal,
    LabelRequest,
    LlmProvider,
    SieveExplanation,
    Suggestion,
} from './provider.js';

/**
 * A model somebody else runs, reached with an API key.
 *
 * **This is the one provider that sends anything off the machine, and that is the whole thing to
 * understand about it.** Ollama answers on localhost and nothing leaves; a hosted model gets the
 * subject lines and sender addresses of the mail a rule would catch. For a tool whose argument is
 * that a Proton account exists to withhold exactly that kind of metadata, this is a real trade —
 * so it is never a default, the interface says what leaves before the key can be entered, and the
 * caller decides.
 *
 * Two shapes, because the well-known providers are not one API. Most speak OpenAI's
 * `/chat/completions` — OpenAI itself, Mistral, Groq, DeepSeek, OpenRouter, and anything else that
 * copied it — and Anthropic speaks its own `/v1/messages`. Rather than pretending one adapter
 * covers both, there are two, and a preset says which a given product needs.
 *
 * There is no logger in this file, and that is not an oversight. This module is bundled into the
 * dashboard, and `@pms/core/logger` builds a pino instance around `process.stderr` at import time —
 * which in a browser is a `ReferenceError` before React renders, leaving a blank page. It happened;
 * `apps/web/test/browser-bundle.test.ts` walks the import graph so it cannot happen again.
 *
 * What comes back goes through exactly the same validation as a local model's answer. A model that
 * costs money is not a model that gets believed: `validateProposal` and `validateLabelProposal` are
 * what stand between a confident sentence and a rule, and they do not care who wrote it.
 */

export type CloudDialect = 'openai' | 'anthropic';

export interface CloudPreset {
    id: string;
    /** What it is called where you buy it. */
    label: string;
    dialect: CloudDialect;
    baseUrl: string;
    /** A sensible default, not a recommendation — a model name ages faster than this file. */
    defaultModel: string;
    /** Where the key comes from, so nobody has to search for it. */
    keysUrl: string;
}

/**
 * The products worth offering by name.
 *
 * Chosen for being well known and for having a key you can get in a minute, not for being best —
 * that is not a judgement this file should be making on somebody's behalf. „Eigene Adresse" is
 * last and covers everything else that speaks OpenAI's dialect, which by now is most things.
 */
export const CLOUD_PRESETS: CloudPreset[] = [
    {
        id: 'openai',
        label: 'OpenAI',
        dialect: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        keysUrl: 'https://platform.openai.com/api-keys',
    },
    {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        dialect: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-haiku-4-5-20251001',
        keysUrl: 'https://console.anthropic.com/settings/keys',
    },
    {
        id: 'mistral',
        label: 'Mistral',
        dialect: 'openai',
        baseUrl: 'https://api.mistral.ai/v1',
        defaultModel: 'mistral-small-latest',
        keysUrl: 'https://console.mistral.ai/api-keys',
    },
    {
        id: 'groq',
        label: 'Groq',
        dialect: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        keysUrl: 'https://console.groq.com/keys',
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        dialect: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'anthropic/claude-3.5-haiku',
        keysUrl: 'https://openrouter.ai/keys',
    },
    {
        id: 'custom',
        label: 'Eigene Adresse (OpenAI-kompatibel)',
        dialect: 'openai',
        baseUrl: '',
        defaultModel: '',
        keysUrl: '',
    },
];

export function presetById(id: string): CloudPreset | undefined {
    return CLOUD_PRESETS.find((preset) => preset.id === id);
}

export interface CloudConfig {
    dialect: CloudDialect;
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export function createCloudProvider(config: CloudConfig): LlmProvider {
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const timeoutMs = config.timeoutMs ?? 60_000;
    const base = config.baseUrl.replace(/\/+$/, '');

    async function ask(prompt: string): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response =
                config.dialect === 'anthropic'
                    ? await fetchImpl(`${base}/messages`, {
                          method: 'POST',
                          headers: {
                              'Content-Type': 'application/json',
                              'x-api-key': config.apiKey,
                              'anthropic-version': '2023-06-01',
                              // Anthropic blocks browser calls unless asked; this dashboard is a
                              // page, and the key belongs to the person looking at it.
                              'anthropic-dangerous-direct-browser-access': 'true',
                          },
                          body: JSON.stringify({
                              model: config.model,
                              max_tokens: 1024,
                              messages: [{ role: 'user', content: prompt }],
                          }),
                          signal: controller.signal,
                      })
                    : await fetchImpl(`${base}/chat/completions`, {
                          method: 'POST',
                          headers: {
                              'Content-Type': 'application/json',
                              Authorization: `Bearer ${config.apiKey}`,
                          },
                          body: JSON.stringify({
                              model: config.model,
                              messages: [{ role: 'user', content: prompt }],
                              temperature: 0,
                          }),
                          signal: controller.signal,
                      });

            if (!response.ok) {
                // The status and nothing else. A provider's error body can quote the prompt back,
                // and the prompt is somebody's subject lines.
                throw new Error(`Das Modell antwortete mit ${String(response.status)}.`);
            }

            const body = (await response.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
                content?: Array<{ text?: string }>;
            };
            return config.dialect === 'anthropic'
                ? (body.content?.[0]?.text ?? '')
                : (body.choices?.[0]?.message?.content ?? '');
        } finally {
            clearTimeout(timer);
        }
    }

    /** Models wrap JSON in prose and in fences however firmly they are asked not to. */
    function extractJson(text: string): unknown {
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
        const candidate = (fenced ?? text).trim();
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end <= start) {
            throw new Error('Das Modell hat kein JSON zurückgegeben.');
        }
        return JSON.parse(candidate.slice(start, end + 1));
    }

    return {
        name: `${config.dialect === 'anthropic' ? 'Anthropic' : 'Cloud'} · ${config.model}`,

        /**
         * Reachability, without spending a request on it.
         *
         * A hosted model costs money per call and rate-limits, so probing it the way the Ollama
         * adapter probes `/api/tags` would be both slower and billable. Configuration is what can
         * be checked for free: a key and a model and somewhere to send them.
         */
        async isAvailable() {
            return config.apiKey !== '' && config.model !== '' && base !== '';
        },

        async suggestFolderName(group: GroupSummary, existingFolders: string[]): Promise<Suggestion> {
            const raw = await ask(
                [
                    'Schlage einen kurzen Ordnernamen für diese E-Mail-Gruppe vor.',
                    `Vorhandene Ordner: ${existingFolders.join(', ') || '(keine)'}`,
                    `Gruppe: ${group.reason}`,
                    `Betreffzeilen: ${group.sampleSubjects.slice(0, 8).join(' | ')}`,
                    'Antworte als JSON: {"value": "...", "rationale": "ein Satz"}',
                ].join('\n')
            );
            const value = extractJson(raw) as { value?: unknown; rationale?: unknown };
            return {
                value: typeof value.value === 'string' ? value.value.slice(0, 60) : '',
                rationale: typeof value.rationale === 'string' ? value.rationale.slice(0, 300) : '',
            };
        },

        async explainSieve(sieve: string): Promise<SieveExplanation> {
            const raw = await ask(
                [
                    'Erkläre dieses Sieve-Filterskript aus Proton Mail in einfachem Deutsch.',
                    'Beschreibe nur, was dasteht. Rate nichts dazu.',
                    '',
                    '```',
                    sieve,
                    '```',
                    '',
                    'Antworte als JSON: {"summary": "ein Satz", "steps": ["...", "..."]}',
                ].join('\n')
            );
            const value = extractJson(raw) as { summary?: unknown; steps?: unknown };
            return {
                summary: typeof value.summary === 'string' ? value.summary : '',
                steps: Array.isArray(value.steps)
                    ? value.steps.filter((step): step is string => typeof step === 'string')
                    : [],
            };
        },

        async proposeRule(selection: SelectionSummary): Promise<RuleProposal> {
            // Same validation as every other provider. What it costs has no bearing on whether it
            // is believed — the matcher decides what a rule catches, here as everywhere.
            return validateProposal(extractJson(await ask(buildProposalPrompt(selection))));
        },

        async proposeLabels(input: LabelRequest): Promise<LabelProposal> {
            return validateLabelProposal(extractJson(await ask(buildLabelPrompt(input))), input);
        },
    };
}
