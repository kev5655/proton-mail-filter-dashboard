export { buildUserAgent, resolveAppVersion, DEFAULT_APP_VERSION, type ReleaseChannel } from './appVersion.js';
export { ProtonHttp, PROTON_API_BASE, type ProtonSession, type ProtonHttpOptions } from './http.js';
export { initCrypto, releaseCrypto } from './crypto.js';
export { login, refreshSession, type LoginCredentials, type LoginResult, type TwoFactorPrompt } from './auth.js';
export {
    getFilters,
    getFolders,
    getLabels,
    getMessages,
    getMessageCounts,
    countMessagesInRange,
    type MessageQuery,
    type MessagePage,
} from './read.js';
export { LoginGuard, isAccountLockout, formatDuration, type LoginAttemptState } from './login-guard.js';
export { loadSession, saveSession, type StoredSession } from './session-store.js';
export { parseResponse } from './validate.js';
export * from './schemas.js';
