export { buildSnapshot } from './snapshot.js';
export { route, READ_ONLY_MESSAGE, type Reply } from './handler.js';
export { serveMailbox, type RunningServer, type ServeOptions } from './serve.js';
export type {
    MailboxFolder,
    MailboxMessage,
    MailboxMeta,
    MailboxRule,
    MailboxSnapshot,
    UnreadableRule,
} from './types.js';
