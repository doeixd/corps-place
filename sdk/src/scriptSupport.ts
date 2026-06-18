// Shared helpers for the maintenance scripts in sdk/scripts. Centralizes the
// env/DB-URL/logo-caching boilerplate that was copy-pasted across the corps
// enrichment scripts, plus the lineup-derived "active corps" set (the SDK mirror
// of app/lib/active-corps.ts).

import type { Effect as EffectNS } from 'effect';
import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MediaService } from './mediaService.js';
import { markCorpsFieldsCurated } from './corpsCuration.js';

/** Minimal structural shape of a synchronous (better-sqlite3) query handle. */
interface SyncQueryable {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * Load `.env` then `../.env` into `process.env` (first definition wins, so an
 * already-set var or the closer file takes precedence). Idempotent.
 */
export const loadDotenv = (): void => {
  for (const p of ['.env', '../.env']) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
};

// Resolve a `file:` libsql URL for a db that may live at `sdk/<name>` (when run
// from the repo root) or `<name>` (when run from inside sdk/), honoring an env
// override first.
const resolveDbUrl = (envVar: string, fileName: string): string => {
  const override = process.env[envVar];
  if (override) return override;
  const inSdk = path.resolve(process.cwd(), 'sdk', fileName);
  return fs.existsSync(inSdk)
    ? `file:${inSdk}`
    : `file:${path.resolve(process.cwd(), fileName)}`;
};

export const resolveRelationalDbUrl = (): string =>
  resolveDbUrl('DCI_RELATIONAL_DB_URL', 'dci-relational.db');

export const resolveMediaCacheDbUrl = (): string =>
  resolveDbUrl('MEDIA_CACHE_DB_URL', 'media-cache.db');

/**
 * Cache a corps logo's bytes through MediaService and point `corps.corps_logo`
 * at the source URL the app serves it by (`/api/media`). The bytes are keyed by
 * `logoUrl`; an expiring/opaque source URL is fine because cache hits are served
 * without re-fetching.
 *
 * Returns `{ format, byteLength }` on success. Does not catch MediaService
 * failures — callers decide how to surface them (e.g. `Effect.result`).
 */
export const cacheCorpsLogo = (
  media: MediaService,
  sql: SqlClient.SqlClient,
  params: { corpsKey: string; name: string; logoUrl: string; via: string; source?: string }
): EffectNS.Effect<{ format: string | null | undefined; byteLength: number }, unknown> =>
  Effect.gen(function* () {
    const asset = yield* (
      media.cache({
        ownerType: 'corps',
        ownerId: params.corpsKey,
        role: 'logo',
        sourceUrl: params.logoUrl,
        attribution: new URL(params.logoUrl).host,
        metadata: { via: params.via, source: params.source, unitName: params.name },
      })
    );
    yield* (sql`UPDATE corps SET corps_logo = ${params.logoUrl} WHERE corps_key = ${params.corpsKey}`);
    // Mark the logo curated so a later DCI ingest never clobbers this hand-set value.
    yield* (markCorpsFieldsCurated(sql, params.corpsKey, ['corps_logo'], params.via));
    return {
      format: asset.format,
      byteLength: Number((asset.metadata as Record<string, unknown> | undefined)?.byteLength ?? 0),
    };
  });

/**
 * SQL EXISTS-fragment body (without the `EXISTS (...)` wrapper) selecting corps
 * that appear in a scored, non-exhibition lineup for a season — the SDK mirror of
 * app/lib/active-corps.ts. Binds one `?` (the season).
 */
export const ACTIVE_SEASON_CORPS_EXISTS_BODY = `SELECT 1 FROM scored_event_lineup sel
  JOIN events ev ON ev.slug = sel.event_slug
  WHERE ev.season = ? AND sel.corps_key = `;

/**
 * The set of corps_keys competing in `season` (appearing in a scored, non-
 * exhibition lineup). Mirrors app/lib/active-corps.ts for better-sqlite3 scripts.
 */
export const activeSeasonCorpsKeys = (db: SyncQueryable, season: string): Set<string> => {
  const rows = db
    .prepare(
      `SELECT DISTINCT sel.corps_key AS k
       FROM scored_event_lineup sel JOIN events e ON e.slug = sel.event_slug
       WHERE e.season = ?`
    )
    .all(season) as Array<{ k: string | null }>;
  return new Set(rows.map((r) => r.k).filter((k): k is string => !!k));
};
