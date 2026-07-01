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
  range: string;
  /** Width of each `series` bucket in ms (5min / hour / day / week / month). */
  bucketMs: number;
  totals: { views: number; visitors: number; events: number };
  /** Time series for the chart: `t` = bucket start (epoch ms). */
  series: { t: number; views: number; visitors: number }[];
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

// Selectable ranges → window (ms back from now; null = all time) + chart bucket width.
const RANGES = {
  '1min': { ms: 60_000, bucket: 5_000 },
  '30min': { ms: 30 * 60_000, bucket: 60_000 },
  '1h': { ms: 3_600_000, bucket: 5 * 60_000 },
  '8h': { ms: 8 * 3_600_000, bucket: 30 * 60_000 },
  '12h': { ms: 12 * 3_600_000, bucket: 3_600_000 },
  '24h': { ms: 24 * 3_600_000, bucket: 3_600_000 },
  '7d': { ms: 7 * 86_400_000, bucket: 86_400_000 },
  '30d': { ms: 30 * 86_400_000, bucket: 86_400_000 },
  '90d': { ms: 90 * 86_400_000, bucket: 86_400_000 },
  '1y': { ms: 365 * 86_400_000, bucket: 7 * 86_400_000 },
  all: { ms: null as number | null, bucket: 30 * 86_400_000 },
} as const;
type RangeKey = keyof typeof RANGES;
const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];

export const getAnalyticsSummary = createServerFn({ method: 'GET' })
  .validator((d: { range?: string } | undefined) => ({
    range: ((RANGE_KEYS as readonly string[]).includes(d?.range ?? '') ? d!.range : '30d') as RangeKey,
  }))
  .handler(async ({ data }): Promise<AnalyticsSummary> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const range = data.range;
    const cfg = RANGES[range];
    const bucketMs = cfg.bucket;
    const empty: AnalyticsSummary = {
      range,
      bucketMs,
      totals: { views: 0, visitors: 0, events: 0 },
      series: [],
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

    // Precise window via the epoch-ms `ts` column (so sub-day ranges like 1h work).
    const sinceMs = cfg.ms == null ? 0 : Date.now() - cfg.ms;
    const q = async (sql: string, args: (number | string)[] = [sinceMs]) =>
      (await db.execute({ sql, args })).rows;

    try {
      const [totals] = await q(
        `SELECT
           SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS views,
           COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
           SUM(CASE WHEN type='event' AND name != 'leave' THEN 1 ELSE 0 END) AS events
         FROM events WHERE ts >= ?`
      );
      // Bucketed time series for the chart: floor(ts / bucketMs) groups pageviews
      // into fixed-width buckets (5min … month, per the selected range).
      const series = await q(
        `SELECT CAST(ts / ? AS INTEGER) AS b, COUNT(*) AS views,
                COUNT(DISTINCT visitor) AS visitors
         FROM events WHERE ts >= ? AND type='pageview' GROUP BY b ORDER BY b`,
        [bucketMs, sinceMs]
      );
      const topPaths = await q(
        `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM events WHERE ts >= ? AND type='pageview' AND path IS NOT NULL
         GROUP BY path ORDER BY views DESC LIMIT 200`
      );
      const topReferrers = await q(
        `SELECT ref_host AS host, COUNT(*) AS views
         FROM events WHERE ts >= ? AND type='pageview' AND ref_host IS NOT NULL
         GROUP BY ref_host ORDER BY views DESC LIMIT 15`
      );
      const topEvents = await q(
        `SELECT name, COUNT(*) AS count
         FROM events WHERE ts >= ? AND type='event' AND name IS NOT NULL AND name != 'leave'
         GROUP BY name ORDER BY count DESC LIMIT 20`
      );
      const byBrand = await q(
        `SELECT COALESCE(brand,'unknown') AS brand, COUNT(*) AS views
         FROM events WHERE ts >= ? AND type='pageview' GROUP BY brand ORDER BY views DESC`
      );
      const byDevice = await q(
        `SELECT COALESCE(device,'unknown') AS device, COUNT(*) AS views
         FROM events WHERE ts >= ? AND type='pageview' GROUP BY device ORDER BY views DESC`
      );
      const [eng] = await q(
        `SELECT
           AVG(CAST(json_extract(props,'$.seconds') AS REAL)) AS s,
           AVG(CAST(json_extract(props,'$.scroll')  AS REAL)) AS sc,
           COUNT(*) AS n
         FROM events WHERE ts >= ? AND name='leave'`
      );
      // Core Web Vitals: p75 per metric (PERCENT_RANK window) — the canonical CWV stat.
      const webVitals = await q(
        `WITH v AS (
           SELECT json_extract(props,'$.metric') AS metric,
                  CAST(json_extract(props,'$.value') AS REAL) AS value
           FROM events WHERE ts >= ? AND name='webvital' AND props IS NOT NULL
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
           FROM events WHERE ts >= ? AND name='webvital'
             AND json_extract(props,'$.metric')='INP' AND path IS NOT NULL
         ),
         ranked AS (
           SELECT path, value, PERCENT_RANK() OVER (PARTITION BY path ORDER BY value) AS pr FROM v
         )
         SELECT path, COUNT(*) AS samples, ROUND(MIN(CASE WHEN pr >= 0.75 THEN value END)) AS p75
         FROM ranked GROUP BY path HAVING samples >= 3 ORDER BY p75 DESC LIMIT 15`
      );

      return {
        range,
        bucketMs,
        totals: { views: num(totals?.views), visitors: num(totals?.visitors), events: num(totals?.events) },
        series: series.map((r) => ({
          t: num(r.b) * bucketMs,
          views: num(r.views),
          visitors: num(r.visitors),
        })),
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
