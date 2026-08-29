import { describe, expect, it } from 'vitest';

import { scrub } from '../src/scrub.js';

/**
 * The fixtures recorded by the spike are meant for a public repository. This suite is what stands
 * between a real mailbox and that repository, so it is written as an attempt to catch the scrubber
 * out rather than to confirm it works.
 */

const realFilterResponse = [
    {
        ID: 'sVKM3_uV0nQwvKgW',
        Name: 'Rechnungen Krankenkasse',
        Status: 1,
        Priority: 2,
        Version: 2,
        Simple: {
            Operator: { label: 'Any', value: 'any' },
            Conditions: [
                {
                    Type: { label: 'Sender', value: 'sender' },
                    Comparator: { label: 'contains', value: 'contains' },
                    Values: ['rechnung@krankenkasse.example', 'no-reply@krankenkasse.example'],
                },
            ],
            Actions: {
                FileInto: ['Finanzen/Krankenkasse'],
                Mark: { Read: false, Starred: false },
            },
        },
        Sieve: 'require ["fileinto"];\nif address :contains "from" "rechnung@krankenkasse.example" { fileinto "Finanzen/Krankenkasse"; }',
    },
];

const secrets = [
    'rechnung@krankenkasse.example',
    'no-reply@krankenkasse.example',
    'Rechnungen Krankenkasse',
    'Finanzen/Krankenkasse',
    'sVKM3_uV0nQwvKgW',
];

describe('fixture scrubbing', () => {
    const scrubbed = JSON.stringify(scrub(realFilterResponse));

    it.each(secrets)('removes %s', (secret) => {
        expect(scrubbed).not.toContain(secret);
    });

    it('removes every email address', () => {
        expect(scrubbed).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
    });

    it('keeps the structure that makes a fixture worth recording', () => {
        const [filter] = scrub(realFilterResponse) as Array<Record<string, unknown>>;
        expect(Object.keys(filter!)).toEqual(Object.keys(realFilterResponse[0]!));
        expect(filter!['Status']).toBe(1);
        expect(filter!['Priority']).toBe(2);
        expect(filter!['Version']).toBe(2);
    });

    it("keeps Proton's structural vocabulary so the shape stays readable", () => {
        const scrubbedFilter = (scrub(realFilterResponse) as Array<Record<string, any>>)[0]!;
        expect(scrubbedFilter['Simple'].Conditions[0].Type.value).toBe('sender');
        expect(scrubbedFilter['Simple'].Conditions[0].Comparator.value).toBe('contains');
    });

    it('maps equal inputs to equal pseudonyms, so grouping survives', () => {
        const result = scrub({ a: { Name: 'same' }, b: { Name: 'same' }, c: { Name: 'other' } }) as Record<
            string,
            { Name: string }
        >;
        expect(result['a']!.Name).toBe(result['b']!.Name);
        expect(result['a']!.Name).not.toBe(result['c']!.Name);
    });

    it('scrubs every element of a user-content array, not just the first', () => {
        const result = scrub({ Keys: ['alice@example.com', 'bob@example.com'] }) as { Keys: string[] };
        expect(result.Keys).toHaveLength(2);
        expect(result.Keys.every((value) => value.startsWith('s:'))).toBe(true);
        expect(result.Keys[0]).not.toBe(result.Keys[1]);
    });

    it('scrubs a long free-text value that happens to look wordlike', () => {
        // `looksStructural` only gates what enters the vocabulary; a value not in it is scrubbed
        // regardless of how innocent it looks.
        const result = scrub({ Whatever: 'Zahnarztrechnung' }) as { Whatever: string };
        expect(result.Whatever).toMatch(/^s:[0-9a-f]{8}$/);
    });
});

describe("keeping Proton's own machinery legible", () => {
    /**
     * Recording a filter is only useful if it can be compiled back and compared. Hashing Proton's
     * generated strings made that impossible — the first real filter recorded came back unusable —
     * so these are kept verbatim. Each pattern is narrow enough that nothing a person typed can
     * pass through it.
     */
    it('keeps the sieve environment variable and its wildcard key', () => {
        const result = scrub({
            Name: 'vnd.proton.spam-threshold',
            Keys: ['*'],
            Value: { Value: '${1}', Type: 'VariableString' },
        }) as Record<string, any>;

        expect(result['Name']).toBe('vnd.proton.spam-threshold');
        expect(result['Keys']).toEqual(['*']);
        expect(result['Value'].Value).toBe('${1}');
    });

    it("keeps Proton's fixed preamble comment", () => {
        const result = scrub({ Text: '# Generated: Do not run this script on spam messages' }) as {
            Text: string;
        };
        expect(result.Text).toBe('# Generated: Do not run this script on spam messages');
    });

    it('keeps the generated rule comment, which differs per filter', () => {
        const comment = '/**\r\n * @type and\r\n * @comparator contains\r\n */';
        expect((scrub({ Text: comment }) as { Text: string }).Text).toBe(comment);
    });

    it('still hashes a comment a person wrote themselves', () => {
        // The prefix is not the licence — the shape is. Anything carrying real content is scrubbed.
        expect((scrub({ Text: '# Meine Notiz zu kevin@example.com' }) as { Text: string }).Text).toMatch(
            /^s:/
        );
        expect(
            (scrub({ Text: '/**\r\n * @type and\r\n * kevin@example.com\r\n */' }) as { Text: string }).Text
        ).toMatch(/^s:/);
    });

    it('still hashes a filter name, even one that looks technical', () => {
        expect((scrub({ Name: 'proton-rechnungen' }) as { Name: string }).Name).toMatch(/^s:/);
    });
});
