declare module "better-sqlite3" {
  interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }

  interface Database {
    prepare(sql: string): Statement;
    close(): void;
  }

  interface DatabaseConstructor {
    new (path: string, options?: { readonly?: boolean }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
