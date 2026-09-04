export { refreshAccountObjects, syncAll, type SyncOptions, type SyncProgress, type SyncResult, type SyncWindow } from './sync.js';
export {
    markAdopted,
    mirrorFilters,
    mirrorLabels,
    mirrorMessages,
    recordCategoryObservations,
    getMeta,
    setMeta,
    type Snapshot,
} from './mirror.js';
export {
    readCategoryChanges,
    readCategoryObservations,
    readFilters,
    readFolderTree,
    readMessages,
    type MessageQuery,
    type StoredFilter,
    type StoredFolder,
    type StoredMessage,
} from './query.js';
