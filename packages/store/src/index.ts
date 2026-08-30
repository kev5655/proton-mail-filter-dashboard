export { openDatabase, closeDatabase, migrate, type Db, type OpenOptions } from './database.js';
export { deriveKey, loadOrCreateHeader, headerPath, type KeyHeader } from './key.js';
export { MIGRATIONS, type Migration } from './schema.js';
