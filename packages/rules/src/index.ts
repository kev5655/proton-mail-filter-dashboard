/**
 * Rule model, compiler and local matcher.
 *
 * The compiler itself is Proton's own, vendored under `vendor/proton/sieve` and re-exported here so
 * the rest of the project has one import site for it. See `test/sieve-compiler.test.ts`.
 */
export { fromSieveTree } from '@proton/sieve/fromSieveTree';
export { toSieveTree } from '@proton/sieve/toSieveTree';
export {
    ConditionComparator,
    ConditionType,
    FilterStatement,
    type Filter,
    type FilterActions,
    type FilterCondition,
    type SimpleObject,
} from '@proton/sieve/filterModel';
export {
    globMatches,
    protonEscapingIsBroken,
    matchesCondition,
    matchesRule,
    resolveOutcome,
    type MatchableMessage,
    type MatchOutcome,
    type OrderedRule,
    type WildcardWarning,
} from './matcher.js';
