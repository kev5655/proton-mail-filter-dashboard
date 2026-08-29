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

export interface LlmProvider {
    readonly name: string;
    /** False when the backend is not reachable; features fall back rather than fail. */
    isAvailable(): Promise<boolean>;

    suggestFolderName(group: GroupSummary, existingFolders: string[]): Promise<Suggestion>;
    explainSieve(sieve: string): Promise<SieveExplanation>;
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
};
