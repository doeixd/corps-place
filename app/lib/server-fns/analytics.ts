import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { requireCapability } from '@/lib/authz';
import { analyticsDb } from '@/lib/analytics/db';

/**
 * Read-only analytics summary for the /admin/analytics dashboard. Gated by the
 * `viewAdmin` capability. All aggregation happens in SQL against the first-party
 * analytics.db; no row-level/visitor data is ever returned to the client.
 */

export type AnalyticsSummary = {
  rangeDays: number;
  totals: { views: number; visitors: number; events: number };
  perDay: { day: string; views: number; visitors: number }[];
  topPaths: { path: string; views: number; visitors: number }[];
  topReferrers: { host: string; views: number }[];
  topEvents: { name: string; count: number }[];
  byBrand: { brand: string; views: number }[];
  byDevice: { device: string; views: number }[];
  engagement: { avgSeconds: number; avgScroll: number; samples: number };
  // Core Web Vitals (field): p75 per metric (ms; CLS is ×1000), + INP by page.
  webVitals: { metric: string; samples: number; p75: number; avg: number }[];
  inpByPath: { path: string; samples: number; p75: number }[];
  available: boolean;
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
// SQL text columns come back as string|null; narrow explicitly so we never
// stringify an object (avoids the no-base-to-string lint + an accidental
// '[object Object]').
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : '';

export const getAnalyticsSummary = createServerFn({ method: 'GET' })
  .validator((d: { days?: number } | undefined) => ({ days: Math.min(365, Math.max(1, d?.days ?? 30)) }))
  .handler(async ({ data }): Promise<AnalyticsSummary> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const days = data.days;
    const empty: AnalyticsSummary = {
      rangeDays: days,
      totals: { views: 0, visitors: 0, events: 0 },
      perDay: [],
      topPaths: [],
      topReferrers: [],
      topEvents: [],
      byBrand: [],
      byDevice: [],
      engagement: { avgSeconds: 0, avgScroll: 0, samples: 0 },
      webVitals: [],
      inpByPath: [],
      available: false,
    };

    const db = await analyticsDb();
    if (!db) return empty;

    // Inclusive lower bound: midnight UTC `days-1` ago (so days=1 means today).
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const q = async (sql: string) => (await db.execute({ sql, args: [since] })).rows;

    try {
      const [totals] = await q(
        `SELECT
           SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS views,
           COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
           SUM(CASE WHEN type='event' AND name != 'leave' THEN 1 ELSE 0 END) AS events
         FROM events WHERE day >= ?`
      );
      const perDay = await q(
        `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM events WHERE day >= ? AND type='pageview' GROUP BY day ORDER BY day`
      );
      const topPaths = await q(
        `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM events WHERE day >= ? AND type='pageview' AND path IS NOT NULL
         GROUP BY path ORDER BY views DESC LIMIT 20`
      );
      const topReferrers = await q(
        `SELECT ref_host AS host, COUNT(*) AS views
         FROM events WHERE day >= ? AND type='pageview' AND ref_host IS NOT NULL
         GROUP BY ref_host ORDER BY views DESC LIMIT 15`
      );
      const topEvents = await q(
        `SELECT name, COUNT(*) AS count
         FROM events WHERE day >= ? AND type='event' AND name IS NOT NULL AND name != 'leave'
         GROUP BY name ORDER BY count DESC LIMIT 20`
      );
      const byBrand = await q(
        `SELECT COALESCE(brand,'unknown') AS brand, COUNT(*) AS views
         FROM events WHERE day >= ? AND type='pageview' GROUP BY brand ORDER BY views DESC`
      );
      const byDevice = await q(
        `SELECT COALESCE(device,'unknown') AS device, COUNT(*) AS views
         FROM events WHERE day >= ? AND type='pageview' GROUP BY device ORDER BY views DESC`
      );
      const [eng] = await q(
        `SELECT
           AVG(CAST(json_extract(props,'$.seconds') AS REAL)) AS s,
           AVG(CAST(json_extract(props,'$.scroll')  AS REAL)) AS sc,
           COUNT(*) AS n
         FROM events WHERE day >= ? AND name='leave'`
      );
      // Core Web Vitals: p75 per metric (PERCENT_RANK window) — the canonical CWV stat.
      const webVitals = await q(
        `WITH v AS (
           SELECT json_extract(props,'$.metric') AS metric,
                  CAST(json_extract(props,'$.value') AS REAL) AS value
           FROM events WHERE day >= ? AND name='webvital' AND props IS NOT NULL
         ),
         ranked AS (
           SELECT metric, value, PERCENT_RANK() OVER (PARTITION BY metric ORDER BY value) AS pr FROM v
         )
         SELECT metric, COUNT(*) AS samples, ROUND(AVG(value)) AS avg,
                ROUND(MIN(CASE WHEN pr >= 0.75 THEN value END)) AS p75
         FROM ranked GROUP BY metric ORDER BY metric`
      );
      // INP p75 by page — where the slow interactions actually are.
      const inpByPath = await q(
        `WITH v AS (
           SELECT path, CAST(json_extract(props,'$.value') AS REAL) AS value
           FROM events WHERE day >= ? AND name='webvital'
             AND json_extract(props,'$.metric')='INP' AND path IS NOT NULL
         ),
         ranked AS (
           SELECT path, value, PERCENT_RANK() OVER (PARTITION BY path ORDER BY value) AS pr FROM v
         )
         SELECT path, COUNT(*) AS samples, ROUND(MIN(CASE WHEN pr >= 0.75 THEN value END)) AS p75
         FROM ranked GROUP BY path HAVING samples >= 3 ORDER BY p75 DESC LIMIT 15`
      );

      return {
        rangeDays: days,
        totals: { views: num(totals?.views), visitors: num(totals?.visitors), events: num(totals?.events) },
        perDay: perDay.map((r) => ({ day: str(r.day), views: num(r.views), visitors: num(r.visitors) })),
        topPaths: topPaths.map((r) => ({ path: str(r.path), views: num(r.views), visitors: num(r.visitors) })),
        topReferrers: topReferrers.map((r) => ({ host: str(r.host), views: num(r.views) })),
        topEvents: topEvents.map((r) => ({ name: str(r.name), count: num(r.count) })),
        byBrand: byBrand.map((r) => ({ brand: str(r.brand), views: num(r.views) })),
        byDevice: byDevice.map((r) => ({ device: str(r.device), views: num(r.views) })),
        engagement: { avgSeconds: Math.round(num(eng?.s)), avgScroll: Math.round(num(eng?.sc)), samples: num(eng?.n) },
        webVitals: webVitals.map((r) => ({
          metric: str(r.metric),
          samples: num(r.samples),
          p75: num(r.p75),
          avg: num(r.avg),
        })),
        inpByPath: inpByPath.map((r) => ({ path: str(r.path), samples: num(r.samples), p75: num(r.p75) })),
        available: true,
      };
    } catch {
      return empty;
    }
  });
