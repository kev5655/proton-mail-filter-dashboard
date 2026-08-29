import { fromSieveTree } from '@proton/sieve/fromSieveTree';
import archive from '@proton/sieve/fixtures/archive';
import folder from '@proton/sieve/fixtures/folder';
import v1StartsEndsTest from '@proton/sieve/fixtures/v1StartsEndsTest';
import v2 from '@proton/sieve/fixtures/v2';
import v2Attachments from '@proton/sieve/fixtures/v2Attachments';
import v2Complex from '@proton/sieve/fixtures/v2Complex';
import v2EscapeVariables from '@proton/sieve/fixtures/v2EscapeVariables';
import v2From from '@proton/sieve/fixtures/v2From';
import v2StartsEndsTest from '@proton/sieve/fixtures/v2StartsEndsTest';
import v2Vacation from '@proton/sieve/fixtures/v2Vacation';
import { toSieveTree } from '@proton/sieve/toSieveTree';
import { describe, expect, it } from 'vitest';

/**
 * The vendored Proton filter compiler, checked against Proton's own fixtures.
 *
 * These are not our test cases — they ship with `@proton/sieve` and encode what Proton's servers
 * actually accept. That is the point: this suite is the tripwire for the vendoring itself. If a
 * `pnpm vendor:update` pulls in a change that alters how a rule compiles, or if our workspace
 * plumbing quietly mangles the package, this fails before a single wrong filter reaches a mailbox.
 *
 * `simple` is the clickable rule the Proton UI shows; `tree` is the Sieve AST stored by
 * `POST mail/v4/filters`. Both directions must hold.
 */

const folderCase = { name: 'folder', fixture: folder } as const;
const v1StartsEndsCase = { name: 'v1StartsEndsTest', fixture: v1StartsEndsTest } as const;

const V1 = [{ name: 'archive', fixture: archive }, folderCase, v1StartsEndsCase] as const;

const V2 = [
    { name: 'v2', fixture: v2 },
    { name: 'v2Attachments', fixture: v2Attachments },
    { name: 'v2Complex', fixture: v2Complex },
    { name: 'v2EscapeVariables', fixture: v2EscapeVariables },
    { name: 'v2From', fixture: v2From },
    { name: 'v2StartsEndsTest', fixture: v2StartsEndsTest },
    { name: 'v2Vacation', fixture: v2Vacation },
] as const;

describe('rule model -> Sieve tree', () => {
    it.each(V1)('compiles $name (version 1)', ({ fixture }) => {
        expect(toSieveTree(fixture.simple, 1)).toEqual(fixture.tree);
    });

    it.each(V2)('compiles $name (version 2)', ({ fixture }) => {
        expect(toSieveTree(fixture.simple, 2)).toEqual(fixture.tree);
    });
});

describe('Sieve tree -> rule model', () => {
    // `archive` is deliberately absent: see the lossiness test below. Proton's own reverse-direction
    // suite leaves it out for the same reason.
    it.each([folderCase, v1StartsEndsCase, ...V2])('parses $name back to the rule model', ({ fixture }) => {
        expect(fromSieveTree(fixture.tree)).toEqual(fixture.simple);
    });
});

describe('version 1 filters lose information', () => {
    /**
     * Version 1 Sieve has no `starts`/`ends`; Proton encoded both as `matches` with a wildcard. So a
     * legacy v1 filter that was authored as "begins with X" comes back from the API as
     * "matches X*", and there is no way to tell it apart from a rule the user really did write as a
     * wildcard match.
     *
     * This is not a defect we can fix — the information is gone before we see it. It is pinned here
     * because it has a visible consequence: an old v1 rule will render in our UI as a wildcard match
     * rather than as "begins with". Rewriting such a rule silently to v2 would change what the user
     * sees without them asking, so v1 filters must be shown as-is and only converted on request.
     */
    it('turns starts/ends into wildcard matches, and leaves everything else intact', () => {
        const describe_ = (condition: { Comparator: { value: string }; Values: string[] }): string =>
            `${condition.Comparator.value}(${condition.Values.join('|')})`;

        const original = archive.simple.Conditions.map(describe_);
        const recovered = (fromSieveTree(archive.tree) as typeof archive.simple).Conditions.map(describe_);

        expect(original).toEqual([
            '!contains(Subject1)',
            'is(Recipient1)',
            '!matches(Recipient2)',
            'starts(Sender1)',
            '!ends(Sender2)',
            '!contains()',
        ]);
        expect(recovered).toEqual([
            '!contains(Subject1)',
            'is(Recipient1)',
            '!matches(Recipient2)',
            // The two that were lost: "begins with Sender1" and "does not end with Sender2".
            'matches(Sender1*)',
            '!matches(*Sender2)',
            '!contains()',
        ]);
    });
});

describe('round trip', () => {
    /**
     * Filters written by hand in the Proton UI come back to us as a tree. We parse it, the user
     * edits it, we compile it again. Anything lost in that cycle is a rule silently changing
     * meaning behind the user's back, so the cycle has to be exact.
     */
    it.each(V2)('$name survives tree -> model -> tree unchanged', ({ fixture }) => {
        const model = fromSieveTree(fixture.tree);
        expect(model).not.toBeNull();
        expect(toSieveTree(model, 2)).toEqual(fixture.tree);
    });
});
