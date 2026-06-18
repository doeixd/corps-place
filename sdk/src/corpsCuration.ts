// Curation: which corps fields were set by hand and must survive the website/API
// ingest. The DCI roster/profile ingest (upsertCorpsProfile in relational.ts)
// otherwise overwrites curated values — e.g. it replaced a hand-picked Mercedes
// logo with the generic `dci-splash` placeholder on the next refresh. Marking a
// field curated tells the upsert to keep the existing value.

import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

/**
 * Corps fields the ingest may clobber and that curation therefore protects.
 * (Identity/derived columns like name/division/active are intentionally absent —
 * those should always track the upstream source.)
 */
export const CURATABLE_FIELDS = [
  'about',
  'display_city',
  'corps_logo',
  'corps_photo',
  'website',
  'facebook',
  'twitter',
  'instagram',
  'youtube',
] as const;
export type CuratableField = (typeof CURATABLE_FIELDS)[number];

/** Substring marking the DCI generic splash image — never a real corps logo. */
export const DCI_PLACEHOLDER_LOGO_MARKER = 'dci-splash';

/**
 * Create the curation table if missing. The canonical definition lives in
 * `ensureRelationalSchema` (relational.ts), but that routine is destructive
 * (drops lineup tables), so curation writers ensure just this one table on their
 * own. `CREATE TABLE IF NOT EXISTS` is idempotent and matches the schema there.
 */
export const ensureCuratedFieldsTable = (
  sql: SqlClient.SqlClient
): Effect.Effect<void, SqlError, never> =>
  sql`
    CREATE TABLE IF NOT EXISTS corps_curated_fields (
      corps_key TEXT NOT NULL,
      field TEXT NOT NULL,
      source TEXT,
      set_at TEXT NOT NULL,
      PRIMARY KEY (corps_key, field)
    )
  `.pipe(Effect.asVoid);

/**
 * Mark `fields` on `corpsKey` as hand-curated so future ingests preserve them.
 * Idempotent (upsert on the composite key); ensures the table exists first.
 */
export const markCorpsFieldsCurated = (
  sql: SqlClient.SqlClient,
  corpsKey: string,
  fields: ReadonlyArray<CuratableField>,
  source: string
): Effect.Effect<void, SqlError, never> =>
  Effect.gen(function* () {
    yield* (ensureCuratedFieldsTable(sql));
    yield* (
      Effect.forEach(
        fields,
        (field) =>
          sql`
            INSERT INTO corps_curated_fields (corps_key, field, source, set_at)
            VALUES (${corpsKey}, ${field}, ${source}, ${new Date().toISOString()})
            ON CONFLICT(corps_key, field) DO UPDATE SET
              source = excluded.source,
              set_at = excluded.set_at
          `,
        { discard: true }
      )
    );
  });

/** The curated field names recorded for a corps. */
export const curatedFieldsFor = (
  sql: SqlClient.SqlClient,
  corpsKey: string
): Effect.Effect<ReadonlySet<string>, SqlError, never> =>
  sql<{ field: string }>`SELECT field FROM corps_curated_fields WHERE corps_key = ${corpsKey}`.pipe(
    Effect.map((rows) => new Set(rows.map((r) => r.field)))
  );
