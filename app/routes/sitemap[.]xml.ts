import { createServerFileRoute } from '@tanstack/react-start/server';
import {
  getCorpsDirectory,
  getJudgeDirectory,
  getMerchStores,
  getMerchCatalogPage,
  getMerchFacets,
  getAllShows,
  getHybridAllEvents,
  getStaffDirectory,
} from '@/lib/server-fns/hybrid';
import { listJobs } from '@/lib/server-fns/jobs';
import { getRankingSeasons } from '@/lib/server-fns/rankings';
import { rankingsCanonicalPath } from '@/lib/rankings/codec';
import { RANK_METRICS } from '@/lib/rankings/types';
import { getVsActiveCorps, getVsSeasonAvailability } from '@/lib/server-fns/vs';
import { getBrand } from '@/lib/brand';
import { LANDING_DEFS } from '@/lib/jobs/landing-taxonomy';

// Brand-aware sitemap. drumcorps.app enumerates the corps content (directories,
// shows, scores, merch); pageantryjobs.com enumerates the job board + every job
// posting — so each host's sitemap only lists its own pages. Cached a day.

const CORPS_STATIC = [
  '/',
  '/events',
  '/scores',
  '/shows',
  '/corps',
  '/judges',
  '/staff',
  '/rankings',
  '/shop',
  '/shop/all',
  '/shop/stores',
];
const JOBS_STATIC = [
  '/',
  '/jobs/board',
  '/jobs/talent',
  '/jobs/post',
  '/jobs/guidelines',
  '/jobs/terms',
  '/jobs/privacy',
];

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildSitemap(
  origin: string,
  paths: Set<string>,
  dated: { loc: string; lastmod?: string }[]
): Response {
  const urls = [
    ...[...paths].map((p) => `  <url><loc>${xmlEscape(origin + p)}</loc></url>`),
    ...dated.map(
      (d) =>
        `  <url><loc>${xmlEscape(origin + d.loc)}</loc>${
          d.lastmod ? `<lastmod>${xmlEscape(d.lastmod)}</lastmod>` : ''
        }</url>`
    ),
  ].join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}

export const ServerRoute = createServerFileRoute('/sitemap.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;

    // pageantryjobs.com → job board + every posting (no corps content).
    if (getBrand(request) === 'jobs') {
      const jobPaths = new Set<string>(JOBS_STATIC);
      jobPaths.add('/jobs/categories');
      const jobDated: { loc: string; lastmod?: string }[] = [];
      let rows: Awaited<ReturnType<typeof listJobs>>['rows'] = [];
      try {
        rows = (await listJobs({ data: { limit: 1000, offset: 0 } })).rows;
        for (const j of rows)
          if (j.slug)
            jobDated.push({ loc: `/jobs/${j.slug}`, lastmod: j.published_at ?? undefined });
      } catch {
        /* postings unavailable — still list the static + landing pages */
      }
      // pSEO landing pages: list ALL of them (each has a unique intro + FAQ), with a
      // <lastmod> from the most recent matching posting when one exists. Match the
      // same way the page filters: discipline exact + title/description keyword.
      for (const def of LANDING_DEFS) {
        const lastmod = rows
          .filter((j) => {
            if (def.filter.discipline && j.discipline !== def.filter.discipline) return false;
            if (def.filter.keyword) {
              const hay = `${j.title ?? ''} ${(j as { content_json?: string }).content_json ?? ''}`.toLowerCase();
              if (!hay.includes(def.filter.keyword.toLowerCase())) return false;
            }
            return true;
          })
          .map((x) => x.published_at)
          .filter((x): x is string => Boolean(x))
          .sort()
          .pop();
        jobDated.push({ loc: `/jobs/c/${def.slug}`, lastmod });
      }
      return buildSitemap(origin, jobPaths, jobDated);
    }

    const paths = new Set<string>(CORPS_STATIC);

    const [corps, judges, staff, stores, facets] = await Promise.all([
      getCorpsDirectory().catch(() => []),
      getJudgeDirectory().catch(() => []),
      getStaffDirectory().catch(() => []),
      getMerchStores().catch(() => []),
      getMerchFacets().catch(() => null),
    ]);

    for (const c of corps) if (c.slug) paths.add(`/corps/${c.slug}`);

    // Show detail pages: /shows/<corpsSlug>/<season>. The read-model keys shows by
    // corps_key, so map each (corpsKey, season) onto the directory slug.
    try {
      const shows = await getAllShows();
      const slugByKey = new Map<string, string>();
      for (const c of corps) if (c.corps_key && c.slug) slugByKey.set(c.corps_key, c.slug);
      for (const sh of shows) {
        const slug = slugByKey.get(sh.corpsKey);
        if (slug) paths.add(`/shows/${slug}/${sh.season}`);
      }
    } catch {
      /* shows unavailable — sitemap still lists everything else */
    }

    // Scored events → /scores/<slug> (the canonical results pages). Carry a
    // <lastmod> (the show date) so search engines know when to (re)crawl results.
    const dated: { loc: string; lastmod?: string }[] = [];
    try {
      const events = await getHybridAllEvents();
      let latestScored: string | undefined;
      // Per-season archive pages (/scores/<year>) get a <lastmod> = that season's
      // most recent scored show.
      const seasonLastmod = new Map<string, string>();
      for (const e of events) {
        // Every event has an indexable hub page at /events/<year>/<slug>/prediction
        // (schedule, lineup, predictions, and scores once posted).
        if (e.season && e.slug)
          dated.push({
            loc: `/events/${e.season}/${e.slug}/prediction`,
            lastmod: e.start_date ?? undefined,
          });
        if (e.scores_released && e.slug) {
          dated.push({ loc: `/scores/${e.slug}`, lastmod: e.start_date ?? undefined });
          if (e.start_date && (!latestScored || e.start_date > latestScored))
            latestScored = e.start_date;
          if (e.season && e.start_date) {
            const prev = seasonLastmod.get(e.season);
            if (!prev || e.start_date > prev) seasonLastmod.set(e.season, e.start_date);
          }
        }
      }
      for (const [season, lastmod] of seasonLastmod)
        dated.push({ loc: `/scores/${season}`, lastmod });
      // Give the /scores index a real freshness signal: the most recent scored
      // show. It changes whenever a new event posts scores, so Google re-crawls
      // the index then (a static path would carry no <lastmod> at all). Drop it
      // from the plain static set so it isn't emitted twice.
      if (latestScored) {
        paths.delete('/scores');
        dated.push({ loc: '/scores', lastmod: latestScored });
      }
    } catch {
      /* events unavailable — sitemap still lists everything else */
    }

    for (const j of judges) if (j.judge_id) paths.add(`/judges/${j.judge_id}`);
    // Staff profiles — the /staff index doesn't server-render its links, so the
    // sitemap is how these get discovered at all.
    for (const s of staff) if (s.person_id) paths.add(`/staff/${s.person_id}`);
    for (const s of stores)
      if (s.productCount > 0) paths.add(`/shop/group/${encodeURIComponent(s.slug)}`);
    if (facets)
      for (const c of facets.categories) paths.add(`/shop/category/${encodeURIComponent(c.value)}`);

    // Page through the merch catalog for product detail URLs.
    try {
      let page = 1;
      let pages = 1;
      do {
        const slice = await getMerchCatalogPage({ data: page });
        for (const p of slice.items) paths.add(`/shop/${p.productId}`);
        pages = slice.pages;
        page += 1;
      } while (page <= pages);
    } catch {
      /* merch catalog unavailable — sitemap still lists everything else */
    }

    // Rankings (pSEO): one indexable URL per season × metric, canonical-collapsed
    // the SAME way the page emits <link rel="canonical"> (shared helper), so the
    // sitemap and the canonical tags agree. Other filters (as-of, division,
    // aggregation, recency) are intentionally excluded — they collapse onto these
    // bases rather than spawning their own thin/duplicate URLs.
    try {
      const { seasons } = await getRankingSeasons();
      const newest = seasons[0];
      if (newest)
        for (const season of seasons)
          for (const metric of RANK_METRICS)
            paths.add(rankingsCanonicalPath(season, metric, newest));
    } catch {
      /* rankings unavailable — sitemap still lists everything else */
    }

    // VS per-corps pSEO (/vs/<slug>): one page per 2026-field corps that also
    // competed in 2025 (the page requires both seasons — others 404, so they're
    // excluded here too).
    try {
      const [{ slugs: roster }, { bySeason }] = await Promise.all([
        getVsActiveCorps(),
        getVsSeasonAvailability(),
      ]);
      const had2025 = new Set(bySeason['2025'] ?? []);
      for (const slug of roster) if (had2025.has(slug)) paths.add(`/vs/${slug}`);
    } catch {
      /* VS data unavailable — sitemap still lists everything else */
    }

    return buildSitemap(origin, paths, dated);
  },
});
