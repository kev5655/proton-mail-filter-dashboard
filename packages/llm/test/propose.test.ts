import { describe, expect, it } from 'vitest';

import { createDemoProvider } from '../src/demo.js';
import { buildProposalPrompt, validateProposal } from '../src/propose.js';

/**
 * The boundary where a language model gets to influence a real mailbox.
 *
 * Everything here is about refusing, not accepting. A model that suggests a folder name can be
 * wrong and cost a rename; a model whose output becomes a filter unchecked can be wrong and cost
 * mail that nobody finds again. So the validator rejects rather than repairs — silently correcting
 * a malformed proposal would mean acting on a guess about what the model meant, and the user would
 * never see that it happened.
 */

const VALID = {
    operator: 'all',
    criteria: [{ field: 'sender', comparator: 'ends', values: ['@beispiel.ch'] }],
    folder: 'Rechnungen',
    rationale: 'Alles von dieser Domäne.',
};

describe('accepting a well-formed proposal', () => {
    it('passes it through, trimmed', () => {
        const result = validateProposal({ ...VALID, folder: '  Rechnungen  ' });

        expect(result.folder).toBe('Rechnungen');
        expect(result.criteria).toEqual([
            { field: 'sender', comparator: 'ends', values: ['@beispiel.ch'] },
        ]);
    });

    it('allows attachments without values, since it is an existence test', () => {
        const result = validateProposal({
            ...VALID,
            criteria: [{ field: 'attachments', comparator: 'contains', values: [] }],
        });

        expect(result.criteria[0]?.field).toBe('attachments');
    });
});

describe('refusing what Proton cannot express', () => {
    it('rejects a field that does not exist', () => {
        // The most likely invention: a model reaching for a header Proton's filters cannot see.
        expect(() =>
            validateProposal({
                ...VALID,
                criteria: [{ field: 'list-id', comparator: 'contains', values: ['x'] }],
            })
        ).toThrow(/list-id/);
    });

    it('rejects a body condition, which Proton filters cannot do at all', () => {
        expect(() =>
            validateProposal({
                ...VALID,
                criteria: [{ field: 'body', comparator: 'contains', values: ['Rechnung'] }],
            })
        ).toThrow(/kein Feld/);
    });

    it('rejects an invented comparator', () => {
        expect(() =>
            validateProposal({
                ...VALID,
                criteria: [{ field: 'sender', comparator: 'regex', values: ['x'] }],
            })
        ).toThrow(/regex/);
    });

    it('rejects a condition with nothing to match on', () => {
        expect(() =>
            validateProposal({
                ...VALID,
                criteria: [{ field: 'sender', comparator: 'contains', values: [] }],
            })
        ).toThrow(/keine Werte/);
    });

    it('rejects a proposal with no conditions, which would match every mail', () => {
        expect(() => validateProposal({ ...VALID, criteria: [] })).toThrow(/keine Bedingungen/);
    });

    it('rejects a folder name that is empty or spans lines', () => {
        expect(() => validateProposal({ ...VALID, folder: '  ' })).toThrow(/Ordnername/);
        expect(() => validateProposal({ ...VALID, folder: 'A\nB' })).toThrow(/Ordnername/);
    });

    it('rejects an unknown operator rather than defaulting to one', () => {
        // Defaulting here would silently turn an OR into an AND, or the reverse.
        expect(() => validateProposal({ ...VALID, operator: 'maybe' })).toThrow(/Verknüpfung/);
    });

    it('rejects anything that is not a proposal at all', () => {
        expect(() => validateProposal('nope')).toThrow();
        expect(() => validateProposal(null)).toThrow();
    });
});

describe('the prompt', () => {
    const prompt = buildProposalPrompt({
        subjects: ['Ihre Rechnung 4711'],
        senders: ['billing@beispiel.ch'],
        instruction: 'es könnte noch ähnliche Mails geben, suche danach',
        existingFolders: ['Rechnungen', 'Newsletter'],
    });

    it('passes the user instruction through verbatim', () => {
        expect(prompt).toContain('es könnte noch ähnliche Mails geben, suche danach');
    });

    it('states the fields and comparators the model is allowed to use', () => {
        expect(prompt).toContain('sender, subject, recipient, attachments');
        expect(prompt).toContain('contains, is, starts, ends, matches');
    });

    it('tells the model to err narrow, because the cost is asymmetric', () => {
        expect(prompt).toContain('eher zu eng als zu weit');
    });
});

describe('the stand-in model', () => {
    const provider = createDemoProvider();

    it('proposes an exact sender when the selection is one sender', async () => {
        const proposal = await provider.proposeRule({
            subjects: ['Angebot'],
            senders: ['news@shop.example'],
            instruction: '',
            existingFolders: [],
        });

        expect(proposal.criteria[0]).toEqual({
            field: 'sender',
            comparator: 'is',
            values: ['news@shop.example'],
        });
    });

    it('widens to the domain when the user asks for similar mail', async () => {
        const proposal = await provider.proposeRule({
            subjects: ['Angebot'],
            senders: ['news@shop.example'],
            instruction: 'es könnte noch ähnliche Mails geben, suche danach',
            existingFolders: [],
        });

        expect(proposal.criteria[0]?.comparator).toBe('ends');
        expect(proposal.criteria[0]?.values).toContain('@shop.example');
        expect(proposal.rationale).toMatch(/weiter gefasst/);
    });

    it('prefers a folder that already exists', async () => {
        const proposal = await provider.proposeRule({
            subjects: ['Ihre Rechnung 4711'],
            senders: ['billing@shop.example'],
            instruction: '',
            existingFolders: ['Rechnungen'],
        });

        expect(proposal.folder).toBe('Rechnungen');
    });

    it('sends its own output through the same validator a real model faces', async () => {
        // If the stand-in could bypass validation, it would be testing a path that does not exist
        // in production.
        const proposal = await provider.proposeRule({
            subjects: [],
            senders: ['a@x.example', 'b@x.example'],
            instruction: '',
            existingFolders: [],
        });

        expect(() => validateProposal(proposal)).not.toThrow();
    });
});
