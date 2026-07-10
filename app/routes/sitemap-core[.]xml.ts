import { createServerFileRoute } from '@tanstack/react-start/server';
import {
  getCorpsDirectory,
  getJudgeDirectory,
  getAllShows,
  getHybridAllEvents,
} from '@/lib/server-fns/hybrid';
import { getRankingSeasons } from '@/lib/server-fns/rankings';
import { rankingsCanonicalPath } from '@/lib/rankings/codec';
import { RANK_METRICS } from '@/lib/rankings/types';
import { getVsActiveCorps, getVsSeasonAvailability } from '@/lib/server-fns/vs';
import { urlsetResponse, honestLastmod, type DatedUrl } from '@/lib/sitemap-shared';

// The CORE sitemap: the content that can actually rank for drum-corps queries —
// scores, events, corps, rankings, judges, shows, vs. Kept separate from the
// bulk staff/shop sitemaps so search engines judge (and crawl) it on its own
// merits. See sitemap-shared.ts for the rationale.

const STATIC_PATHS = ['/', '/events', '/scores', '/shows', '/corps', '/judges', '/rankings'];

export const ServerRoute = createServerFileRoute('/sitemap-core.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;
    const paths = new Set<string>(STATIC_PATHS);
    const dated: DatedUrl[] = [];

    const [corps, judges] = await Promise.all([
      getCorpsDirectory().catch(() => []),
      getJudgeDirectory().catch(() => []),
    ]);
    for (const c of corps) if (c.slug) paths.add(`/corps/${c.slug}`);
    for (const j of judges) if (j.judge_id) paths.add(`/judges/${j.judge_id}`);

    // Show detail pages: /shows/<corpsSlug>/<season>.
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

    // Events + scored results. lastmod only when honest: a scored show's date is
    // when its results appeared; a FUTURE show date is not a modification time
    // (emitting those made Google distrust every lastmod on the site).
    try {
      const events = await getHybridAllEvents();
      let latestScored: string | undefined;
      const seasonLastmod = new Map<string, string>();
      for (const e of events) {
        if (e.season && e.slug)
          dated.push({
            loc: `/events/${e.season}/${e.slug}/prediction`,
            lastmod: honestLastmod(e.start_date),
          });
        if (e.scores_released && e.slug) {
          const lm = honestLastmod(e.start_date);
          dated.push({ loc: `/scores/${e.slug}`, lastmod: lm });
          if (lm && (!latestScored || lm > latestScored)) latestScored = lm;
          if (e.season && lm) {
            const prev = seasonLastmod.get(e.season);
            if (!prev || lm > prev) seasonLastmod.set(e.season, lm);
          }
        }
      }
      for (const [season, lastmod] of seasonLastmod)
        dated.push({ loc: `/scores/${season}`, lastmod });
      if (latestScored) {
        paths.delete('/scores');
        dated.push({ loc: '/scores', lastmod: latestScored });
      }
    } catch {
      /* events unavailable — sitemap still lists everything else */
    }

    // Rankings pSEO: one URL per season × metric (± single division), matching the
    // pages' own canonical collapsing.
    try {
      const { seasons } = await getRankingSeasons();
      const newest = seasons[0];
      if (newest)
        for (const season of seasons)
          for (const metric of RANK_METRICS)
            for (const div of [undefined, ['world'], ['open'], ['all-age']] as const)
              paths.add(rankingsCanonicalPath(season, metric, newest, div));
    } catch {
      /* rankings unavailable */
    }

    // VS per-corps pSEO: only corps present in both compared seasons.
    try {
      const [{ slugs: roster }, { bySeason }] = await Promise.all([
        getVsActiveCorps(),
        getVsSeasonAvailability(),
      ]);
      const had2025 = new Set(bySeason['2025'] ?? []);
      for (const slug of roster) if (had2025.has(slug)) paths.add(`/vs/${slug}`);
    } catch {
      /* VS data unavailable */
    }

    return urlsetResponse(origin, paths, dated);
  },
});
