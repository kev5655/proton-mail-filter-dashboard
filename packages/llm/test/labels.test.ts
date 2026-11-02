import { describe, expect, it } from 'vitest';

import { buildLabelPrompt, validateLabelProposal } from '../src/labels.js';
import type { LabelRequest } from '../src/provider.js';

/**
 * What the model may decide about labels, and what it may not.
 *
 * A model asked to "suggest labels" invents one every time, and a mailbox grows a dozen
 * near-synonyms — „Rechnung", „Rechnungen", „Belege", „Buchhaltung" — each with its own rule, none
 * of them wrong and all of them noise. So the existing labels always go with the question and the
 * task is to *choose from them*.
 *
 * The prompt asks for that. This is what makes it true: everything the model names is matched
 * against the account's own labels, and anything unmatched is an invention that is dropped unless
 * inventing was explicitly allowed. A model does not get to widen its own permission by answering
 * confidently.
 */

const request = (over: Partial<LabelRequest> = {}): LabelRequest => ({
    subjects: ['Rechnung März', 'Rechnung April'],
    senders: ['buchhaltung@firma.example'],
    existingLabels: ['Steuerrelevant', 'Zu erledigen'],
    allowNew: false,
    ...over,
});

describe('the question the model is asked', () => {
    it('carries the labels it is supposed to choose from', () => {
        const prompt = buildLabelPrompt(request());

        expect(prompt).toContain('Steuerrelevant');
        expect(prompt).toContain('Zu erledigen');
    });

    it('forbids inventing when inventing was not allowed', () => {
        expect(buildLabelPrompt(request())).toContain('Erfinde keine neuen Labels');
    });

    it('allows exactly one invention when it was', () => {
        const prompt = buildLabelPrompt(request({ allowNew: true }));

        expect(prompt).toContain('höchstens eines');
    });

    it('says that choosing nothing is a valid answer', () => {
        // A model that must return something returns something, and the something is wrong.
        expect(buildLabelPrompt(request())).toContain('lieber keines als ein unpassendes');
    });
});

describe('what comes back', () => {
    it('keeps a label that exists', () => {
        const result = validateLabelProposal({ chosen: ['Steuerrelevant'], rationale: 'passt' }, request());

        expect(result.chosen).toEqual(['Steuerrelevant']);
        expect(result.proposedNew).toEqual([]);
    });

    it('matches case-insensitively, so it does not create a near-duplicate', () => {
        // „rechnungen" for a label called „Rechnungen" means the existing one. Treating it as an
        // invention would create a second label differing only in case, which is precisely the
        // outcome this design exists to prevent.
        const result = validateLabelProposal(
            { chosen: ['steuerrelevant'] },
            request({ allowNew: true })
        );

        expect(result.chosen).toEqual(['Steuerrelevant']);
        expect(result.proposedNew).toEqual([]);
    });

    it('drops an invention when inventing was not allowed', () => {
        const result = validateLabelProposal({ chosen: ['Buchhaltung'] }, request());

        expect(result.chosen).toEqual([]);
        expect(result.proposedNew).toEqual([]);
    });

    it('keeps an invention apart from the choices when it was allowed', () => {
        const result = validateLabelProposal(
            { chosen: ['Steuerrelevant', 'Buchhaltung'] },
            request({ allowNew: true })
        );

        expect(result.chosen).toEqual(['Steuerrelevant']);
        expect(result.proposedNew).toEqual(['Buchhaltung']);
    });

    it('takes at most one invention however many come back', () => {
        // A model returning five new labels has not understood the question, and acting on all
        // five would multiply the problem it was asked to avoid.
        const result = validateLabelProposal(
            { proposedNew: ['Eins', 'Zwei', 'Drei', 'Vier', 'Fünf'] },
            request({ allowNew: true })
        );

        expect(result.proposedNew).toHaveLength(1);
    });

    it('survives an answer that is not the shape it asked for', () => {
        // The model is not a contract. An empty answer is a usable state; a thrown error in the
        // middle of a rule editor is not.
        expect(validateLabelProposal('nein danke', request())).toEqual({
            chosen: [],
            proposedNew: [],
            rationale: '',
        });
        expect(validateLabelProposal({ chosen: [1, null, ''] }, request()).chosen).toEqual([]);
    });
});
