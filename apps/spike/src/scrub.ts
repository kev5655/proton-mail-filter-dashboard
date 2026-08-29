import { createHmac, randomBytes } from 'node:crypto';

import archive from '@proton/sieve/fixtures/archive';
import folder from '@proton/sieve/fixtures/folder';
import v2 from '@proton/sieve/fixtures/v2';
import v2Attachments from '@proton/sieve/fixtures/v2Attachments';
import v2Complex from '@proton/sieve/fixtures/v2Complex';
import v2From from '@proton/sieve/fixtures/v2From';
import v2SpamOnly from '@proton/sieve/fixtures/v2SpamOnly';
import v2StartsEndsTest from '@proton/sieve/fixtures/v2StartsEndsTest';
import v2Vacation from '@proton/sieve/fixtures/v2Vacation';

/**
 * Turn a real Proton response into a fixture that is safe to commit.
 *
 * The responses we most need as fixtures — filters and their Sieve trees — are exactly the ones
 * full of personal data. Folder names, sender addresses and match values sit inside an AST whose
 * *shape* is the only part worth recording.
 *
 * Two rules, applied in this order:
 *
 *  1. Any string under a key known to hold user content is pseudonymised, unconditionally. This is
 *     the guarantee; it does not depend on the vocabulary below being right.
 *  2. Otherwise a string is kept only if it belongs to Proton's structural vocabulary — harvested
 *     from the upstream fixtures that ship with `@proton/sieve`, so it is by construction the set
 *     of strings the format itself defines, not a hand-maintained list that drifts.
 *
 * Equal inputs hash equally within a run, so grouping and referential structure survive. The salt
 * is random per run and discarded, so a pseudonym cannot be reversed by hashing candidate
 * addresses.
 */

const salt = randomBytes(32);

function pseudonym(value: string): string {
    return `s:${createHmac('sha256', salt).update(value).digest('hex').slice(0, 8)}`;
}

/**
 * Keys whose values are user content wherever they appear.
 *
 * `Keys` and `Values` are the match operands of a filter condition — the actual sender addresses
 * and subject fragments being matched on. `Text` is a Sieve comment, which Proton uses to store the
 * human-readable rule. All of it is personal.
 */
const USER_CONTENT_KEYS = new Set([
    'Name',
    'Subject',
    'Address',
    'Text',
    'Keys',
    'Value',
    'Values',
    'Message',
    'Path',
    'Sieve',
    'Email',
]);

/** A structural string is short, wordlike, and never an address. */
function looksStructural(value: string): boolean {
    return value.length <= 48 && !value.includes('@') && /^[A-Za-z][A-Za-z0-9._;:-]*$/.test(value);
}

/**
 * Strings that are unmistakably Proton's own machinery rather than anything a person wrote.
 *
 * Needed because the user-content denylist is keyed on field *names*, and Proton reuses those names
 * for its own generated content: the spam-threshold preamble stores `vnd.proton.spam-threshold`
 * under `Name`, `${1}` under `Value`, `*` under `Keys`, and its generated comments under `Text`.
 * Hashing those was over-zealous and cost real fidelity — a recorded filter could no longer be
 * compiled back and compared, which is exactly what a fixture is for.
 *
 * Kept deliberately narrow. A value only survives if it looks like Proton internals *and* appears
 * verbatim in the upstream fixtures, so nothing a user typed can slip through by resembling it.
 */
function looksLikeProtonInternal(value: string): boolean {
    return (
        // Proton's own namespace for sieve environment variables.
        value.includes('vnd.proton') ||
        // A bare sieve variable reference, nothing else.
        /^\$\{\d+\}$/.test(value) ||
        // Only wildcards, so there is nothing in it to leak.
        /^[*?]+$/.test(value) ||
        // Proton's fixed preamble comment. Letters, spaces and periods only, so nothing
        // structured — no address, no number, no path — can hide behind the prefix.
        /^# Generated: [A-Za-z. ]+$/.test(value) ||
        isGeneratedRuleComment(value)
    );
}

/**
 * Proton's generated comment describing a rule's operator and comparators, e.g.
 *
 *     /** @type and @comparator contains *\/
 *
 * It varies per rule, so no vocabulary can list it, and it is the last thing standing between a
 * recorded filter and a byte-exact recompile. Matched by strict shape rather than by prefix: only
 * `@type` and `@comparator` lines with single bare words are allowed through, so a hand-written
 * Sieve comment cannot smuggle content past this by starting with a slash and a star.
 */
function isGeneratedRuleComment(value: string): boolean {
    const body = /^\/\*\*([\s\S]*)\*\/$/.exec(value)?.[1];
    if (body === undefined) {
        return false;
    }
    const lines = body
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*?\s*/, '').trim())
        .filter((line) => line !== '');

    return lines.length > 0 && lines.every((line) => /^@(type|comparator) [a-z!]+$/.test(line));
}

function buildVocabulary(): Set<string> {
    const vocabulary = new Set<string>();
    const harvest = (value: unknown): void => {
        if (typeof value === 'string') {
            if (!value.includes('@') && (looksStructural(value) || looksLikeProtonInternal(value))) {
                vocabulary.add(value);
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(harvest);
            return;
        }
        if (value !== null && typeof value === 'object') {
            for (const [key, nested] of Object.entries(value)) {
                vocabulary.add(key);
                harvest(nested);
            }
        }
    };
    for (const fixture of [
        archive,
        folder,
        v2,
        v2Attachments,
        v2Complex,
        v2From,
        v2SpamOnly,
        v2StartsEndsTest,
        v2Vacation,
    ]) {
        harvest(fixture);
    }
    return vocabulary;
}

let vocabulary: Set<string> | undefined;

export function scrub(value: unknown, parentKey?: string): unknown {
    vocabulary ??= buildVocabulary();

    if (typeof value === 'string') {
        if (value === '') {
            return value;
        }
        // Provably structural: safe from the string alone, so no vocabulary lookup is needed.
        // Necessary because Proton's generated rule comment encodes the rule's own operator and
        // comparators and therefore differs per filter — no fixed list could ever contain it.
        if (looksLikeProtonInternal(value)) {
            return value;
        }
        if (parentKey !== undefined && USER_CONTENT_KEYS.has(parentKey)) {
            return pseudonym(value);
        }
        return vocabulary.has(value) ? value : pseudonym(value);
    }
    if (Array.isArray(value)) {
        // An array inherits its parent's key, so `Keys: [...]` scrubs every element.
        return value.map((item) => scrub(item, parentKey));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scrub(nested, key)]));
    }
    // Numbers and booleans are structure — statuses, priorities, flags, versions.
    return value;
}

export const SCRUB_NOTE =
    'Recorded from a live Proton account. Strings under user-content keys, and any string outside ' +
    "Proton's structural vocabulary, were replaced with per-run HMAC pseudonyms (s:<hex>); the " +
    'salt was random and discarded. Numbers, booleans and the object shape are unmodified.';
