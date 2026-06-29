import { createClient, type Client } from '@libsql/client';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * First-party analytics store (privacy-friendly, cookieless). A tiny, append-only
 * event log — pageviews, domain events, outbound clicks, engagement — kept SEPARATE
 * from the read-model (which hot-swaps A/B slots) and from contributions.db (auth /
 * wiki writes). Best-effort by design: analytics must NEVER break a request, so the
 * accessor returns null and callers no-op on any failure.
 *
 * Durability: in prod this lives on the Coolify /data volume (the container FS is
 * rebuilt each deploy). Set ANALYTICS_DB_URL=file:/data/analytics.db; otherwise we
 * auto-pick /data when it's writable, else a repo-local file for zero-config dev.
 */

const repoRoot = process.cwd();

const resolveUrl = (): string => {
  if (process.env.ANALYTICS_DB_URL) return process.env.ANALYTICS_DB_URL;
  // Prefer the durable volume when present + writable (prod), else repo-local (dev).
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return 'file:/data/analytics.db';
  } catch {
    return `file:${path.resolve(repoRoot, 'sdk', 'analytics.db')}`;
  }
};

const PRAGMAS = [
  'PRAGMA journal_mode=WAL', // many tiny inserts + occasional dashboard reads
  'PRAGMA busy_timeout=3000',
  'PRAGMA synchronous=NORMAL',
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS events (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     ts      INTEGER NOT NULL,        -- epoch ms
     day     TEXT    NOT NULL,        -- YYYY-MM-DD (UTC)
     type    TEXT    NOT NULL,        -- 'pageview' | 'event'
     name    TEXT,                    -- event name (null for pageview)
     path    TEXT,                    -- normalized URL path
     brand   TEXT,                    -- 'corps' | 'jobs'
     ref_host TEXT,                   -- referrer host only (no full URL / query)
     visitor TEXT,                    -- daily-rotating salted hash (no PII, no cookie)
     device  TEXT,                    -- 'mobile' | 'tablet' | 'desktop'
     props   TEXT                     -- JSON extras (outbound url, scroll %, …)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_day ON events(day)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type_day ON events(type, day)`,
  `CREATE INDEX IF NOT EXISTS idx_events_name_day ON events(name, day)`,
  `CREATE INDEX IF NOT EXISTS idx_events_path_day ON events(type, path, day)`,
];

let ready: Promise<Client | null> | null = null;

// Open the client and run pragmas + DDL to completion BEFORE anyone inserts, so the
// first event after a cold start can't race the CREATE TABLE and get dropped. The
// promise is memoized, so the schema work happens exactly once per process.
const init = async (): Promise<Client | null> => {
  try {
    const c = createClient({ url: resolveUrl() });
    for (const p of PRAGMAS) await c.execute(p);
    for (const d of DDL) await c.execute(d);
    return c;
  } catch {
    return null; // store unavailable — callers treat analytics as best-effort
  }
};

/**
 * The shared analytics client, resolved only once its schema exists. Returns null
 * when the store can't be opened (analytics is always best-effort).
 */
export const analyticsDb = (): Promise<Client | null> => (ready ??= init());
