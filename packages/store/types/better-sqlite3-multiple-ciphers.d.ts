/**
 * Hand-written boundary for the SQLCipher driver.
 *
 * Only what this project uses is declared, so an upstream change surfaces as a compile error here
 * rather than as a database that silently opens unencrypted. `pragma` in particular is the call the
 * whole encryption rests on.
 *
 * A hand-written declaration is a promise the compiler cannot check, so `test/encryption.test.ts`
 * checks the behaviour at runtime instead — the same arrangement as `@protontech/crypto`.
 */
declare module 'better-sqlite3-multiple-ciphers' {
    namespace Database {
        interface Statement {
            run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
            get(...params: unknown[]): unknown;
            all(...params: unknown[]): unknown[];
        }

        interface Database {
            readonly open: boolean;
            readonly name: string;
            prepare(source: string): Statement;
            exec(source: string): Database;
            pragma(source: string, options?: { simple?: boolean }): unknown;
            transaction<T extends (...args: never[]) => unknown>(fn: T): T;
            close(): Database;
        }
    }

    class Database implements Database.Database {
        constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean });
        readonly open: boolean;
        readonly name: string;
        prepare(source: string): Database.Statement;
        exec(source: string): Database.Database;
        pragma(source: string, options?: { simple?: boolean }): unknown;
        transaction<T extends (...args: never[]) => unknown>(fn: T): T;
        close(): Database.Database;
    }

    export = Database;
}
