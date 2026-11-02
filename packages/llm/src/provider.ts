/**
 * The language model, wherever it happens to live.
 *
 * One interface, several backends: a local Ollama, a remote one on a server, Proton's Lumo when it
 * ever gains an API, or none at all. Nothing else in the project may know which is in use, and
 * every feature that depends on one has to degrade to something honest when there is none.
 *
 * The important rule is about *what* the model is allowed to decide. It names things and explains
 * things. It does not decide what a rule matches, which mails a rule catches, or what gets written
 * to Proton — those come from the compiler and the matcher, which are checkable. A model that
 * merely suggests a folder name can be wrong and cost a rename; a model trusted to say what a
 * filter does can be wrong and cost mail nobody ever finds.
 */

import type { RuleProposal, SelectionSummary } from './propose.js';

export interface GroupSummary {
    reason: string;
    sampleSubjects: string[];
    senderDomain: string;
    categories: string[];
    size: number;
}

export interface Suggestion {
    value: string;
    /** Why the model chose it, in one sentence, shown next to the suggestion. */
    rationale: string;
}

/**
 * An explanation of a Sieve script.
 *
 * Always presented as generated text alongside the structural rendering derived from the script
 * itself, never instead of it. The derived version is what the code can verify; this is prose to
 * help read it, and it can be wrong.
 */
export interface SieveExplanation {
    summary: string;
    /** Step by step, in the order the script runs. */
    steps: string[];
}

/** What the model is told, and the labels it is meant to choose from. */
export interface LabelRequest {
    /** Subjects of the mail the rule would catch. No bodies — there are none. */
    subjects: string[];
    senders: string[];
    /** Every label the account already has. The answer is supposed to come from here. */
    existingLabels: string[];
    /** Set when the user explicitly asked for new labels to be considered. */
    allowNew: boolean;
}

export interface LabelProposal {
    /** Labels that already exist. Safe to apply — nothing is created. */
    chosen: string[];
    /**
     * Labels the model invented, kept apart from the ones that exist.
     *
     * Empty unless `allowNew` was set. Even then each one is a separate decision in the interface:
     * a label is a thing that will still be in the mailbox in a year.
     */
    proposedNew: string[];
    /** One sentence on why, shown next to the answer and labelled as generated. */
    rationale: string;
}

export interface LlmProvider {
    readonly name: string;
    /** False when the backend is not reachable; features fall back rather than fail. */
    isAvailable(): Promise<boolean>;

    suggestFolderName(group: GroupSummary, existingFolders: string[]): Promise<Suggestion>;
    explainSieve(sieve: string): Promise<SieveExplanation>;

    /**
     * Which of the account's existing labels fit this mail — and only exceptionally, a new one.
     *
     * The existing labels always go with the question, and the task is to *choose from them*. That
     * is not politeness: a model asked to name a label will invent one every time, and a mailbox
     * grows a dozen near-synonyms — „Rechnung", „Rechnungen", „Belege", „Buchhaltung" — each with
     * its own rule, none of them wrong and all of them noise.
     *
     * So the two kinds of answer come back separately. `chosen` are labels that already exist and
     * can be applied at once. `proposedNew` are inventions, shown apart, ticked individually, and
     * created only if somebody says so. A model cannot slide a new label into the list by naming
     * it confidently.
     */
    proposeLabels(input: LabelRequest): Promise<LabelProposal>;

    /**
     * Propose *criteria* for a rule from a hand-picked set of mail.
     *
     * On the interface rather than on one implementation, which it was not before: the selection
     * dialog reached for the demo provider directly, so configuring a real model changed nothing
     * where it mattered. A settings screen offering Ollama while the one feature that needs a model
     * still asked the stand-in would have been a lie with a form in front of it.
     *
     * The return value is criteria, never a rule and never a verdict. They are validated against
     * what Proton can express, compiled by our compiler and run through the matcher before anything
     * is shown — so what the user sees is the real list of affected mail, not the model's claim
     * about it.
     */
    proposeRule(selection: SelectionSummary): Promise<RuleProposal>;
}

/** Used when no model is configured. Every caller must handle this without breaking. */
export const NO_PROVIDER: LlmProvider = {
    name: 'kein Modell',
    async isAvailable() {
        return false;
    },
    async suggestFolderName() {
        throw new Error('Kein Sprachmodell konfiguriert.');
    },
    async explainSieve() {
        throw new Error('Kein Sprachmodell konfiguriert.');
    },
    async proposeRule() {
        throw new Error('Kein Sprachmodell konfiguriert.');
    },
    async proposeLabels() {
        throw new Error('Kein Sprachmodell konfiguriert.');
    },
};
