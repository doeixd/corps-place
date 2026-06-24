// Single source of truth for additive column migrations on contributions.db.
//
// SQLite's `ALTER TABLE ADD COLUMN` errors if the column already exists, so each
// entry is applied guarded by a `PRAGMA table_info` check. Plain ESM (no app/TS
// imports) so BOTH the app (app/lib/contributions-db.ts imports this) AND the
// standalone boot-time migrator (scripts/migrate-contributions.mjs) use the exact
// same list — they can never drift. Append new columns here.

/** @type {{ table: string; column: string; ddl: string }[]} */
export const ADD_COLUMNS = [
  { table: 'show_revisions', column: 'hidden', ddl: 'ALTER TABLE show_revisions ADD COLUMN hidden INTEGER DEFAULT 0' },
  { table: 'show_media', column: 'hidden', ddl: 'ALTER TABLE show_media ADD COLUMN hidden INTEGER DEFAULT 0' },
  // better-auth admin plugin columns on the `user` table (ADMIN_PAGE_PLAN §7).
  { table: 'user', column: 'banned', ddl: 'ALTER TABLE "user" ADD COLUMN banned INTEGER DEFAULT 0' },
  { table: 'user', column: 'banReason', ddl: 'ALTER TABLE "user" ADD COLUMN banReason TEXT' },
  { table: 'user', column: 'banExpires', ddl: 'ALTER TABLE "user" ADD COLUMN banExpires TEXT' },
  { table: 'email_log', column: 'status', ddl: 'ALTER TABLE email_log ADD COLUMN status TEXT' },
  { table: 'fantasy_leagues', column: 'image_media_id', ddl: 'ALTER TABLE fantasy_leagues ADD COLUMN image_media_id TEXT' },
  // First-sign-in consent (site-wide gate). camelCase column names match the
  // better-auth additionalFields keys in auth.ts so the session exposes them.
  { table: 'user', column: 'termsAcceptedAt', ddl: 'ALTER TABLE "user" ADD COLUMN termsAcceptedAt TEXT' },
  { table: 'user', column: 'termsVersion', ddl: 'ALTER TABLE "user" ADD COLUMN termsVersion TEXT' },
  { table: 'user', column: 'contactConsent', ddl: 'ALTER TABLE "user" ADD COLUMN contactConsent INTEGER DEFAULT 0' },
  // Per-member notification opt-outs (default on).
  { table: 'fantasy_members', column: 'notify_email', ddl: 'ALTER TABLE fantasy_members ADD COLUMN notify_email INTEGER DEFAULT 1' },
  { table: 'fantasy_members', column: 'notify_push', ddl: 'ALTER TABLE fantasy_members ADD COLUMN notify_push INTEGER DEFAULT 1' },
  // Fantasy Test Lab — sandbox league + bot users (docs/plans/FANTASY_TEST_LAB_PLAN.md).
  { table: 'fantasy_leagues', column: 'is_test', ddl: 'ALTER TABLE fantasy_leagues ADD COLUMN is_test INTEGER DEFAULT 0' },
  { table: 'user', column: 'isBot', ddl: 'ALTER TABLE "user" ADD COLUMN isBot INTEGER DEFAULT 0' },
];

/**
 * Apply every guarded ADD COLUMN against a libsql client. Resilient: a failure on
 * one column logs and continues so it never blocks the rest (or the app boot).
 * Returns the count actually added. `quote` table names that are reserved words.
 * @param {{ execute: (q: string) => Promise<{ rows: any[] }> }} db
 */
export async function applyAddColumns(db) {
  let added = 0;
  for (const { table, column, ddl } of ADD_COLUMNS) {
    try {
      const q = table === 'user' ? 'PRAGMA table_info("user")' : `PRAGMA table_info(${table})`;
      const cols = (await db.execute(q)).rows.map((r) => r.name);
      if (cols.includes(column)) continue;
      await db.execute(ddl);
      added++;
    } catch (err) {
      // Table may not exist yet (fresh DB, created by the app's CREATE TABLE batch)
      // or a transient lock — log and move on; the next run/path retries.
      console.error(`[migrate] ${table}.${column} skipped: ${(err && err.message) || err}`);
    }
  }
  return added;
}
