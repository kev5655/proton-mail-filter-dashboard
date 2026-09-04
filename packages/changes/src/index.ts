export { describeChange } from './describe.js';
export {
    Journal,
    inverseOf,
    type JournalEntry,
    type MovedMessage,
    type VerificationResult,
} from './journal.js';
export {
    applyChangeToRules,
    describePlan,
    planCategoryMove,
    planChange,
    planUndo,
    type CategoryMoveInput,
    type ChangeKind,
    type ChangePlan,
    type Move,
    type PendingChange,
    type PlanInput,
    type UndoableEntry,
} from './plan.js';
export {
    findRulesNotFiring,
    partialMoveError,
    verifyMoves,
    type HealthFinding,
    type MessageState,
    type VerifyInput,
} from './verify.js';
