export { backupBeforeWrite, type BackupResult } from './backup.js';
export {
    applyFiltersToExisting,
    createFilter,
    deleteFilter,
    reorderFilters,
    setFilterEnabled,
    updateFilter,
    type FilterPayload,
} from './filters.js';
export { createFolder, deleteFolder, updateFolder, type FolderPayload } from './labels.js';
// `messages.ts` is deliberately absent: it is the undo-only exception and must be imported
// directly by the undo service, so that write-isolation.test.ts can see who depends on it.
