/**
 * A synthetic mailbox, for tests only.
 *
 * This was `@pms/demo`, a workspace package the dashboard imported and fell back to whenever the
 * local server did not answer. That fallback is gone — see `src/mailbox.tsx` for why — and with it
 * the reason for this to be a package at all. It lives under `test/` now, which is the guarantee:
 * nothing in `src/` can reach it, and `no-demo.test.ts` checks that it stays that way.
 *
 * It is deliberately awkward — a sender whose mail splits in two, a rule that never fires, one that
 * is always overridden, folders shadowing Proton's own — because a tidy fixture makes every screen
 * look good and proves nothing.
 */

export { bodyFor, BODIES, type DemoBody } from './bodies.js';
export {
    generateMailbox,
    ARCHIVE,
    DEMO_FOLDERS,
    DEMO_LABELS,
    INBOX,
    type DemoFilter,
    type DemoFolder,
    type DemoMessage,
    type MailboxOptions,
} from './mailbox.js';
export { DEMO_RULES } from './filters.js';
export {
    demoHistoryIsWellFormed,
    DEMO_CATEGORY_CHANGES,
    DEMO_CATEGORY_IDS,
    DEMO_CATEGORY_OBSERVATIONS,
    DEMO_SYNC_TIMES,
    type DemoCategoryChange,
    type DemoObservation,
} from './category-history.js';
