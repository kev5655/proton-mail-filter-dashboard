export {
    groupMessages,
    categoryIdsOf,
    CATEGORY_IDS,
    CATEGORY_LABELS,
    INBOX_LABEL,
    PROTON_CATEGORY_ORDER,
    SYSTEM_LOCATIONS,
    type GroupableMessage,
    type GroupingOptions,
    type GroupKind,
    type MessageGroup,
} from './group.js';
export {
    emailDomain,
    normalizeAddress,
    registrableDomain,
    stripReplyPrefixes,
    subjectTemplate,
    subjectTemplateKey,
} from './normalize.js';
export {
    categoryName,
    deriveAutoRules,
    DOMINANT_SHARE,
    MIN_MESSAGES_FOR_STABLE,
    MIN_SYNCS_FOR_STABLE,
    type AutoRule,
    type AutoRuleVerdict,
    type CategoryChange,
    type CategoryObservation,
    type DeriveInput,
} from './auto-rules.js';
export { explainScore, scoreGroup, scoreGroups, type ScoredGroup } from './score.js';
