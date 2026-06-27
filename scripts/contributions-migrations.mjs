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
  { table: 'user', column: 'timeZone', ddl: 'ALTER TABLE "user" ADD COLUMN timeZone TEXT' },
  // Per-member notification opt-outs (default on).
  { table: 'fantasy_members', column: 'notify_email', ddl: 'ALTER TABLE fantasy_members ADD COLUMN notify_email INTEGER DEFAULT 1' },
  { table: 'fantasy_members', column: 'notify_push', ddl: 'ALTER TABLE fantasy_members ADD COLUMN notify_push INTEGER DEFAULT 1' },
  // Fantasy Test Lab — sandbox league + bot users (docs/plans/FANTASY_TEST_LAB_PLAN.md).
  { table: 'fantasy_leagues', column: 'is_test', ddl: 'ALTER TABLE fantasy_leagues ADD COLUMN is_test INTEGER DEFAULT 0' },
  { table: 'user', column: 'isBot', ddl: 'ALTER TABLE "user" ADD COLUMN isBot INTEGER DEFAULT 0' },
  // Auto-start a scheduled draft at its scheduled time (vs. owner starting manually).
  { table: 'fantasy_drafts', column: 'auto_start', ddl: 'ALTER TABLE fantasy_drafts ADD COLUMN auto_start INTEGER DEFAULT 1' },
  // PageantryJobs — ZIP-based location + sort-by-closest.
  { table: 'jobs_profile', column: 'zip', ddl: 'ALTER TABLE jobs_profile ADD COLUMN zip TEXT' },
  { table: 'jobs_posting', column: 'zip', ddl: 'ALTER TABLE jobs_posting ADD COLUMN zip TEXT' },
  { table: 'jobs_posting', column: 'location_lat', ddl: 'ALTER TABLE jobs_posting ADD COLUMN location_lat REAL' },
  { table: 'jobs_posting', column: 'location_lng', ddl: 'ALTER TABLE jobs_posting ADD COLUMN location_lng REAL' },
  // PageantryJobs — profile photo (reuses fantasy_media + /api/fantasy-media).
  { table: 'jobs_profile', column: 'image_media_id', ddl: 'ALTER TABLE jobs_profile ADD COLUMN image_media_id TEXT' },
  // PageantryJobs — directory visibility (0 = visible in talent directory, 1 = hidden/link-only).
  { table: 'jobs_profile', column: 'directory_opt_out', ddl: 'ALTER TABLE jobs_profile ADD COLUMN directory_opt_out INTEGER DEFAULT 0' },
  // PageantryJobs — applicant pipeline status (new | reviewed | shortlisted | passed).
  { table: 'jobs_application', column: 'status', ddl: "ALTER TABLE jobs_application ADD COLUMN status TEXT DEFAULT 'new'" },
  // PageantryJobs — single-select discipline dimension on postings + profiles.
  { table: 'jobs_posting', column: 'discipline', ddl: 'ALTER TABLE jobs_posting ADD COLUMN discipline TEXT' },
  { table: 'jobs_profile', column: 'discipline', ddl: 'ALTER TABLE jobs_profile ADD COLUMN discipline TEXT' },
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

/**
 * Seed the `zip_centroid` lookup table (zip → lat/lng) from the bundled CSV.
 * Idempotent: creates the table if missing and only bulk-loads when it's empty.
 * Best-effort — any failure is thrown to the caller, which logs and continues boot.
 * ZIPs in the CSV have leading zeros stripped, so we zero-pad to 5 chars.
 * @param {{ execute: (q: string) => Promise<{ rows: any[] }>; batch: (stmts: any[]) => Promise<any> }} db
 * @returns {Promise<number>} rows seeded this run (0 if already populated)
 */
export async function seedZipCentroids(db) {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS zip_centroid (zip TEXT PRIMARY KEY, lat REAL, lng REAL)'
  );

  const countRows = (await db.execute('SELECT count(*) AS c FROM zip_centroid')).rows;
  const existing = Number(countRows[0]?.c ?? 0);
  if (existing > 0) return 0;

  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(new URL('./zip-centroids.csv', import.meta.url), 'utf8');
  const lines = csv.split(/\r?\n/);

  /** @type {{ sql: string; args: any[] }[]} */
  let chunk = [];
  let seeded = 0;
  const SQL = 'INSERT OR IGNORE INTO zip_centroid (zip, lat, lng) VALUES (?, ?, ?)';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [rawZip, latStr, lngStr] = line.split(',');
    const zip = String(rawZip).padStart(5, '0');
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (zip.length !== 5 || Number.isNaN(lat) || Number.isNaN(lng)) continue;
    chunk.push({ sql: SQL, args: [zip, lat, lng] });
    if (chunk.length >= 1000) {
      await db.batch(chunk);
      seeded += chunk.length;
      chunk = [];
    }
  }
  if (chunk.length) {
    await db.batch(chunk);
    seeded += chunk.length;
  }
  return seeded;
}
