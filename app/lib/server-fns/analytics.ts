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
  available: boolean;
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
const str = (v: unknown): string => (v == null ? '' : String(v));

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
      available: false,
    };

    const db = analyticsDb();
    if (!db) return empty;

    // Inclusive lower bound: midnight UTC `days-1` ago (so days=1 means today).
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const q = async (sql: string) => (await db.execute({ sql, args: [since] })).rows;

    try {
      const [totals] = await q(
        `SELECT
           SUM(CASE WHEN type='pageview' THEN 1 ELSE 0 END) AS views,
           COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) AS visitors,
           SUM(CASE WHEN type='event' THEN 1 ELSE 0 END) AS events
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
        available: true,
      };
    } catch {
      return empty;
    }
  });
