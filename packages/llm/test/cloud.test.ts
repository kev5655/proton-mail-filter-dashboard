import { describe, expect, it } from 'vitest';

import { CLOUD_PRESETS, createCloudProvider, presetById } from '../src/cloud.js';

/**
 * A model somebody else runs — the one provider that sends anything off the machine.
 *
 * Everything here turns on that. Ollama answers on localhost and nothing leaves; a hosted model
 * gets the subject lines and sender addresses of the mail a rule would catch. So the tests worth
 * having are not about happy paths: they are about what is sent, what is believed, and what an
 * error is allowed to say.
 */

interface Call {
    url: string;
    headers: Record<string, string>;
    body: unknown;
}

function fake(answer: string, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
        calls.push({
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return new Response(answer, { status, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, calls };
}

const openaiAnswer = (content: string): string =>
    JSON.stringify({ choices: [{ message: { content } }] });

describe('the two dialects', () => {
    it('speaks OpenAI to the OpenAI-compatible ones', async () => {
        const { fetchImpl, calls } = fake(openaiAnswer('{"chosen":["Steuerrelevant"]}'));
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: 'k',
            model: 'm',
            fetchImpl,
        });

        await provider.proposeLabels({
            subjects: ['Rechnung'],
            senders: ['a@b.example'],
            existingLabels: ['Steuerrelevant'],
            allowNew: false,
        });

        expect(calls[0]?.url).toBe('https://api.example/v1/chat/completions');
        expect(calls[0]?.headers['Authorization']).toBe('Bearer k');
    });

    it('speaks Anthropic to Anthropic, rather than pretending one API covers both', async () => {
        const { fetchImpl, calls } = fake(
            JSON.stringify({ content: [{ text: '{"chosen":["Steuerrelevant"]}' }] })
        );
        const provider = createCloudProvider({
            dialect: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            apiKey: 'k',
            model: 'm',
            fetchImpl,
        });

        await provider.proposeLabels({
            subjects: ['Rechnung'],
            senders: ['a@b.example'],
            existingLabels: ['Steuerrelevant'],
            allowNew: false,
        });

        expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
        expect(calls[0]?.headers['x-api-key']).toBe('k');
        expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    });
});

describe('what it is allowed to believe', () => {
    it('validates a label answer exactly as a local model’s is validated', async () => {
        // A model that costs money is not a model that gets believed. „Buchhaltung" does not exist
        // in this account and inventing was not allowed, so it is dropped — the same rule that
        // applies to Ollama.
        const { fetchImpl } = fake(openaiAnswer('{"chosen":["Steuerrelevant","Buchhaltung"]}'));
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: 'k',
            model: 'm',
            fetchImpl,
        });

        const result = await provider.proposeLabels({
            subjects: ['Rechnung'],
            senders: ['a@b.example'],
            existingLabels: ['Steuerrelevant'],
            allowNew: false,
        });

        expect(result.chosen).toEqual(['Steuerrelevant']);
        expect(result.proposedNew).toEqual([]);
    });

    it('digs the JSON out of prose and fences, because models wrap it', async () => {
        const { fetchImpl } = fake(
            openaiAnswer('Gerne! ```json\n{"chosen":["Steuerrelevant"]}\n``` Hoffe das hilft.')
        );
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: 'k',
            model: 'm',
            fetchImpl,
        });

        const result = await provider.proposeLabels({
            subjects: ['Rechnung'],
            senders: ['a@b.example'],
            existingLabels: ['Steuerrelevant'],
            allowNew: false,
        });

        expect(result.chosen).toEqual(['Steuerrelevant']);
    });

    it('reports a refusal by status and does not quote the body back', async () => {
        // A provider's error body can echo the prompt, and the prompt is somebody's subject lines.
        const { fetchImpl } = fake(JSON.stringify({ error: { message: 'Rechnung März ist ungültig' } }), 401);
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: 'falsch',
            model: 'm',
            fetchImpl,
        });

        await expect(
            provider.proposeLabels({ subjects: ['Rechnung März'], senders: [], existingLabels: [], allowNew: false })
        ).rejects.toThrow(/401/);
        await expect(
            provider.proposeLabels({ subjects: ['Rechnung März'], senders: [], existingLabels: [], allowNew: false })
        ).rejects.not.toThrow(/Rechnung März/);
    });
});

describe('being configured is not being reachable', () => {
    it('checks the configuration rather than spending a request', async () => {
        // Probing a hosted model costs money and a rate-limit slot. What can be checked for free is
        // that there is a key, a model and somewhere to send them — and the interface says
        // „eingerichtet" rather than „erreichbar" because of it.
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: 'k',
            model: 'm',
            fetchImpl: (() => {
                throw new Error('should not be called');
            }) as unknown as typeof fetch,
        });

        expect(await provider.isAvailable()).toBe(true);
    });

    it('says no when a piece is missing', async () => {
        const provider = createCloudProvider({
            dialect: 'openai',
            baseUrl: 'https://api.example/v1',
            apiKey: '',
            model: 'm',
        });

        expect(await provider.isAvailable()).toBe(false);
    });
});

describe('the presets', () => {
    it('names products people can actually get a key for', () => {
        expect(CLOUD_PRESETS.map((preset) => preset.id)).toContain('openai');
        expect(CLOUD_PRESETS.map((preset) => preset.id)).toContain('anthropic');
    });

    it('leaves the address empty for the custom one, and only for that one', () => {
        // That empty string is what the settings screen keys the address field off, so it is
        // behaviour rather than data.
        const empty = CLOUD_PRESETS.filter((preset) => preset.baseUrl === '');
        expect(empty.map((preset) => preset.id)).toEqual(['custom']);
    });

    it('gives every named product a link to where the key comes from', () => {
        for (const preset of CLOUD_PRESETS.filter((entry) => entry.id !== 'custom')) {
            expect(preset.keysUrl, preset.id).toMatch(/^https:\/\//);
        }
    });

    it('resolves an unknown id to nothing rather than to a default somebody did not pick', () => {
        expect(presetById('gibt-es-nicht')).toBeUndefined();
    });
});
