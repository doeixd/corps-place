import { createServerFn } from '@tanstack/react-start';
import { getContributionsDb } from '@/lib/contributions-db';

// When were scores last actually published? Sourced from the auto-ingest cron's
// ingest_runs log (status='published' = new scores landed and were emitted) —
// the only honest sub-day freshness signal we have. Feeds the /scores page's
// visible "Updated …" line and its JSON-LD dateModified so search engines can
// show a freshness label. Degrades to null (dev boxes may lack the table).

let cache: { value: string | null; expiresAt: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export const getScoresLastPublished = createServerFn({ method: 'GET' }).handler(
  async (): Promise<string | null> => {
    if (cache && cache.expiresAt > Date.now()) return cache.value;
    let value: string | null = null;
    try {
      const db = await getContributionsDb();
      const res = await db.execute(
        "SELECT ts FROM ingest_runs WHERE status = 'published' ORDER BY ts DESC LIMIT 1"
      );
      const ts = res.rows[0]?.ts;
      if (typeof ts === 'string' && ts) value = ts;
    } catch {
      /* table absent (dev) or db unavailable — omit the freshness signal */
    }
    cache = { value, expiresAt: Date.now() + TTL_MS };
    return value;
  }
);
