// Dev-only color editor save (CORPS_COLORS_PLAN step 4). Writes a corps's two
// brand colors to the relational source DB (the durable source of truth) and
// marks them curated so a re-ingest/re-extract never clobbers a hand-pick. Also
// best-effort patches the live read-model slot so the change shows immediately in
// dev without a full re-emit.
//
// Gated on DEV: there is no admin auth yet, so this never ships to production.

import { createServerFn } from '@tanstack/react-start/client';
import { Schema, SchemaParser } from 'effect';
import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import { normalizeHex } from '@sdk/src/corpsColors.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

const isDev = process.env.NODE_ENV !== 'production';

const SaveInput = Schema.Struct({
  corpsKey: Schema.String.check(Schema.isMinLength(1)),
  primary: Schema.String.check(Schema.isMinLength(1)),
  // Empty string clears the secondary (single-hue corps).
  secondary: Schema.String,
});

// Lazily-resolved relational client (server-only; mirrors corps-directory.ts).
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);
let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

export const saveCorpsColors = createServerFn({ method: 'POST' })
  .validator(SchemaParser.decodeUnknownSync(SaveInput))
  .handler(async ({ data }) => {
    if (!isDev) throw new Error('The corps color editor is only available in development.');

    const primary = normalizeHex(data.primary);
    if (!primary) throw new Error(`Invalid primary color: ${data.primary}`);
    const secondary = data.secondary.trim() ? normalizeHex(data.secondary) : null;
    if (data.secondary.trim() && !secondary)
      throw new Error(`Invalid secondary color: ${data.secondary}`);

    const db = getDb();
    // Source of truth: the corps row + a curated-field marker so extract/ingest
    // leaves this corps's colors alone going forward.
    await db.execute({
      sql: `UPDATE corps SET color_primary = ?, color_secondary = ?, color_source = 'manual' WHERE corps_key = ?`,
      args: [primary, secondary, data.corpsKey],
    });
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS corps_curated_fields (
              corps_key TEXT NOT NULL, field TEXT NOT NULL, source TEXT, set_at TEXT NOT NULL,
              PRIMARY KEY (corps_key, field))`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO corps_curated_fields (corps_key, field, source, set_at)
            VALUES (?, 'colors', 'color-editor', ?)
            ON CONFLICT(corps_key, field) DO UPDATE SET source = excluded.source, set_at = excluded.set_at`,
      args: [data.corpsKey, new Date().toISOString()],
    });

    // Best-effort live patch of the active read-model slot so the editor + site
    // reflect the change without a 2-minute full re-emit. Durability is already
    // guaranteed by the relational write above; a later full emit re-publishes it.
    if (readModelEnabled()) {
      try {
        await getReadModelClient().execute({
          sql: `UPDATE rm_corps SET color_primary = ?, color_secondary = ?, color_source = 'manual' WHERE corps_key = ?`,
          args: [primary, secondary, data.corpsKey],
        });
      } catch {
        /* slot patch is best-effort; relational write is the durable one */
      }
    }

    return { corpsKey: data.corpsKey, primary, secondary, color_source: 'manual' as const };
  });
