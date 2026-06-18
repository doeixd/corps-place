import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import * as cheerio from 'cheerio';
import {
  getLatestCorpsPageScrape,
  upsertCorpsPageScrape,
  matchExistingCorpsKey,
} from './relational.js';
import {
  isCorpsProfile,
  parseCorpsProfile,
  parseCorpsClassFromText,
  type CorpsProfile,
} from './corpsParser.js';
import { corpsProfileUrl, type FetchHtml } from './corpsScraper.js';
import type { DciNetworkError } from './errors.js';
import { LEGACY_CORPS_NAMES, isLegacyCorpsName } from './legacyCorps.js';

/**
 * Lineup-driven corps discovery (M1 + M2 of the lineup-discovery plan).
 *
 * The roster scrape (`corpsScraper.ts`) only covers corps on dci.org's `/corps/`
 * directory. Many corps that actually compete (SoundSport / affiliate units like
 * Sky Ryders, Arsenal) are absent from that directory yet still have a profile
 * page. This module enumerates competing corps from event lineups, probes
 * dci.org for a matching profile (trying slug variants), and archives the result
 * honestly — real HTTP status, 404s included — so a known-missing slug isn't
 * re-probed every run.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

const isFresh = (scrapedAt: string, ttlMs: number) => {
  const at = Date.parse(scrapedAt);
  return Number.isFinite(at) && Date.now() - at < ttlMs;
};

const WAYBACK_AVAILABLE_URL = 'https://archive.org/wayback/available';

const normalizeNameKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const parseCorpsSnapshotEntries = (responseJson: string) => {
  try {
    const parsed = JSON.parse(responseJson) as unknown;
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (parsed != null && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  return [];
};

/* ----------------------------- slug guessing ------------------------------ */

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/['’".]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const KNOWN_CORPS_SLUGS = new Map<string, readonly string[]>([
  ['cadets2', ['cadets2']],
]);

// Ordered, de-duplicated DCI slug candidates for a corps. dci.org slugs are
// inconsistent: some are the bare name (`sky-ryders`), others append the full
// "drum bugle corps" (`arsenal-drum-bugle-corps`). Try the known corps slug
// first, then the name and its common suffix/strip variants.
export const guessCorpsSlugs = (name: string, existingSlug?: string | null): string[] => {
  const base = slugify(name);
  const stripped = base.replace(/-(drum-bugle-corps|drum-and-bugle-corps|dbc)$/i, '');
  const known = KNOWN_CORPS_SLUGS.get(normalizeNameKey(name)) ?? [];
  const candidates = [
    existingSlug ?? undefined,
    ...known,
    base,
    `${base}-drum-bugle-corps`,
    `${stripped}-drum-bugle-corps`,
    stripped,
  ].filter((s): s is string => !!s && s.length > 1);
  return [...new Set(candidates)];
};

/* ------------------------------ favicon -------------------------------- */

// Resolve a corps' own-site favicon from its homepage HTML, for use as a logo
// fallback when dci.org has no logo image. Prefers the largest declared
// apple-touch-icon / rel=icon; falls back to `/favicon.ico`.
export const resolveFavicon = (siteHtml: string, siteUrl: string): string | null => {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return null;
  }
  const $ = cheerio.load(siteHtml);
  const links = $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]')
    .map((_, el) => ({
      href: $(el).attr('href') ?? '',
      sizes: $(el).attr('sizes') ?? '',
      rel: $(el).attr('rel') ?? '',
    }))
    .get()
    .filter((l) => l.href);
  // Score by declared pixel size; when unsized, apple-touch-icons are typically
  // large (~120px), other icons small (~16px). Pick the largest.
  const declaredSize = (sizes: string) => Number(/(\d+)x\d+/i.exec(sizes)?.[1] ?? 0);
  const best = links
    .map((l) => ({
      ...l,
      score: declaredSize(l.sizes) || (l.rel.includes('apple-touch-icon') ? 120 : 16),
    }))
    .sort((a, b) => b.score - a.score)[0];
  const href = best?.href ?? '/favicon.ico';
  try {
    return new URL(href, origin).toString();
  } catch {
    return null;
  }
};

const fetchWaybackPage = (fetchHtml: FetchHtml, targetUrl: string) =>
  Effect.gen(function* () {
    const availability = yield* (
      fetchHtml(`${WAYBACK_AVAILABLE_URL}?url=${encodeURIComponent(targetUrl)}`).pipe(
        Effect.orElseSucceed(() => '')
      )
    );
    if (!availability) return null;
    let snapshotUrl: string | null = null;
    try {
      const parsed = JSON.parse(availability) as {
        archived_snapshots?: { closest?: { available?: boolean; url?: string } };
      };
      const snapshot = parsed.archived_snapshots?.closest;
      if (snapshot?.available && snapshot.url) snapshotUrl = snapshot.url;
    } catch {
      return null;
    }
    if (!snapshotUrl) return null;
    const html = yield* (fetchHtml(snapshotUrl).pipe(Effect.orElseSucceed(() => '')));
    return html ? { url: snapshotUrl, html } : null;
  });

/* ------------------------------ probe ---------------------------------- */

export interface ProbeResult {
  readonly slug: string;
  readonly url: string;
  readonly status: number;
  /** True only for a 200 that passes the profile content guard. */
  readonly isProfile: boolean;
  readonly fromCache: boolean;
  readonly profile?: CorpsProfile;
  /** Raw HTML when available (fresh fetch or cache hit), for further parsing. */
  readonly html?: string;
}

// Probe one slug: replay a fresh archived result (incl. a cached 404) or fetch.
// Archives the real HTTP status; a non-profile/404 is stored too so it isn't
// re-probed within the TTL.
export const probeCorpsProfile = (
  slug: string,
  options: {
    readonly fetchHtml: FetchHtml;
    readonly refresh?: boolean;
    readonly ttlMs?: number;
    readonly allowWayback?: boolean;
  }
): Effect.Effect<ProbeResult, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const url = corpsProfileUrl(slug);
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    if (!options.refresh) {
      const cached = yield* (getLatestCorpsPageScrape(sql, slug));
      const shouldUseCache =
        cached &&
        isFresh(cached.scrapedAt, ttlMs) &&
        (cached.httpStatus !== 200 || cached.rawHtml.length > 0);
      if (shouldUseCache) {
        const status = cached.httpStatus ?? 0;
        const isProfile = status === 200 && cached.rawHtml.length > 0 && isCorpsProfile(cached.rawHtml);
        return {
          slug,
          url,
          status,
          isProfile,
          fromCache: true,
          profile: isProfile ? parseCorpsProfile(cached.rawHtml) : undefined,
          html: cached.rawHtml || undefined,
        };
      }
    }

    const fetched = yield* (options.fetchHtml(url).pipe(Effect.result));
    const scrapedAt = new Date().toISOString();

    if (fetched._tag === 'Failure') {
      // Browserbase throws a DciNetworkError carrying the HTTP status (404 for a
      // missing corps). Archive the miss so we don't re-probe it within the TTL.
      const status = (fetched.failure as DciNetworkError).statusCode || 0;
      yield* (
        upsertCorpsPageScrape(sql, {
          corpsSlug: slug,
          pageType: 'profile',
          sourceUrl: url,
          httpStatus: status,
          rawHtml: '',
          parsed: { notFound: true },
          scrapedAt,
        })
      );
      if (options.allowWayback !== false && status === 404) {
        const wayback = yield* (fetchWaybackPage(options.fetchHtml, url));
        if (wayback) {
          const isProfile = isCorpsProfile(wayback.html);
          const profile = isProfile ? parseCorpsProfile(wayback.html) : undefined;
          if (isProfile) {
            yield* (
              upsertCorpsPageScrape(sql, {
                corpsSlug: slug,
                pageType: 'profile',
                sourceUrl: wayback.url,
                httpStatus: 200,
                rawHtml: wayback.html,
                parsed: profile ?? { notProfile: true },
                scrapedAt: new Date().toISOString(),
              })
            );
          }
          return {
            slug,
            url: wayback.url,
            status: 200,
            isProfile,
            fromCache: false,
            profile,
            html: wayback.html,
          };
        }
      }
      return { slug, url, status, isProfile: false, fromCache: false };
    }

    const html = fetched.success;
    const isProfile = isCorpsProfile(html);
    const profile = isProfile ? parseCorpsProfile(html) : undefined;
    yield* (
      upsertCorpsPageScrape(sql, {
        corpsSlug: slug,
        pageType: 'profile',
        sourceUrl: url,
        httpStatus: 200,
        rawHtml: html,
        parsed: profile ?? { notProfile: true },
        scrapedAt,
      })
    );
    return { slug, url, status: 200, isProfile, fromCache: false, profile, html };
  });

/* --------------------------- competing corps --------------------------- */

export interface CompetingCorps {
  readonly unitName: string;
  readonly displayCity: string | null;
  readonly source: 'lineup' | 'cached-corps' | 'historical-corps';
  /** Resolved canonical key, or null if the unit doesn't match any corps row. */
  readonly corpsKey: string | null;
  readonly existingSlug: string | null;
  readonly divisionName: string | null;
  readonly hasLogo: boolean;
  /** True if a profile page has already been archived for `existingSlug`. */
  /** True if the corps has already been ingested (roster pass or prior discovery apply). */
  readonly hasBeenIngested: boolean;
}

const loadHistoricalCorpsFromSnapshots = (
  sql: SqlClient.SqlClient
): Effect.Effect<readonly CompetingCorps[], SqlError, never> =>
  Effect.gen(function* () {
    const rows = yield* (
      sql<{ response_json: string }>`
        SELECT response_json
        FROM api_responses
        WHERE endpoint_type = 'corps'
        ORDER BY fetched_at DESC
      `
    );

    const seen = new Map<
      string,
      { name: string; slug: string | null; displayCity: string | null; source: 'historical-corps' }
    >();
    for (const name of LEGACY_CORPS_NAMES) {
      const key = normalizeNameKey(name);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        name,
        slug: null,
        displayCity: null,
        source: 'historical-corps',
      });
    }
    for (const row of rows) {
      for (const item of parseCorpsSnapshotEntries(row.response_json)) {
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name || !isLegacyCorpsName(name)) continue;
        const key = normalizeNameKey(name);
        if (!key || seen.has(key)) continue;
        seen.set(key, {
          name,
          slug: typeof item.slug === 'string' && item.slug.trim() ? item.slug.trim() : null,
          displayCity: typeof item.displayCity === 'string' && item.displayCity.trim()
            ? item.displayCity.trim()
            : null,
          source: 'historical-corps',
        });
      }
    }

    const out: CompetingCorps[] = [];
    for (const entry of seen.values()) {
      const corpsKey =
        (yield* (matchExistingCorpsKey(sql, { name: entry.name, location: entry.displayCity }))) ??
        null;
      let existingSlug: string | null = null;
      let divisionName: string | null = null;
      let hasLogo = false;
      if (corpsKey) {
        const row = yield* (
          sql<{ slug: string | null; division_name: string | null; corps_logo: string | null }>`
            SELECT slug, division_name, corps_logo FROM corps WHERE corps_key = ${corpsKey} LIMIT 1
          `.pipe(Effect.map((rows) => rows[0]))
        );
        existingSlug = row?.slug ?? null;
        divisionName = row?.division_name ?? null;
        hasLogo = !!row?.corps_logo;
      }
      const hasBeenIngested = corpsKey
        ? yield* (
            sql<{ n: number }>`
              SELECT count(*) AS n FROM corps_class_history WHERE corps_key = ${corpsKey}
            `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0))
          )
        : false;
      out.push({
        unitName: entry.name,
        displayCity: entry.displayCity,
        source: entry.source,
        corpsKey,
        existingSlug: existingSlug ?? entry.slug,
        divisionName,
        hasLogo,
        hasBeenIngested,
      });
    }

    return out;
  });

// Enumerate the distinct performing units in a season's lineups and resolve each
// to a corps row (alias/name/city-aware). The candidate set for discovery is the
// subset with no archived profile scrape — i.e. corps the roster pass never
// covered.
export const listCompetingCorps = (
  season: number
): Effect.Effect<readonly CompetingCorps[], SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const units = yield* (
      // events.season is stored as TEXT — bind a string so the comparison matches
      // (the driver doesn't apply column affinity to bound numeric params).
      sql<{ unit_name: string; display_city: string | null }>`
        SELECT DISTINCT le.unit_name, le.display_city
        FROM classified_event_lineup le
        JOIN events e ON e.slug = le.event_slug
        WHERE e.season = ${String(season)}
          AND le.effective_is_non_performance = 0
          AND le.is_non_corps = 0
        ORDER BY le.unit_name
      `
    );

    const out: CompetingCorps[] = [];
    for (const u of units) {
      const corpsKey =
        (yield* (matchExistingCorpsKey(sql, { name: u.unit_name, location: u.display_city }))) ??
        null;
      let existingSlug: string | null = null;
      let divisionName: string | null = null;
      let hasLogo = false;
      if (corpsKey) {
        const row = yield* (
          sql<{ slug: string | null; division_name: string | null; corps_logo: string | null }>`
            SELECT slug, division_name, corps_logo FROM corps WHERE corps_key = ${corpsKey} LIMIT 1
          `.pipe(Effect.map((rows) => rows[0]))
        );
        existingSlug = row?.slug ?? null;
        divisionName = row?.division_name ?? null;
        hasLogo = !!row?.corps_logo;
      }
      // "Covered" = already ingested (roster pass or a prior discovery apply),
      // signalled by a corps_class_history row. NOT merely "a profile was
      // archived" — a dry-run archives profiles without ingesting, so gating on
      // the archive would orphan dry-run finds (they'd be skipped on the apply).
      const hasBeenIngested = corpsKey
        ? yield* (
            sql<{ n: number }>`
              SELECT count(*) AS n FROM corps_class_history WHERE corps_key = ${corpsKey}
            `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0))
          )
        : false;
      out.push({
        unitName: u.unit_name,
        displayCity: u.display_city,
        source: 'lineup',
        corpsKey,
        existingSlug,
        divisionName,
        hasLogo,
        hasBeenIngested,
      });
    }
    return out;
  });

/* ----------------------------- discovery ------------------------------- */

export interface DiscoveredCorps {
  readonly unitName: string;
  readonly corpsKey: string | null;
  /** The slug whose profile we found (200 + profile), or null if none matched. */
  readonly slug: string | null;
  readonly status: number;
  readonly triedSlugs: readonly string[];
  /** Class parsed from the profile's about prose (fallback class signal). */
  readonly textDivision?: string | null;
  /** Corps-site favicon URL, resolved only when the DCI page has no logo. */
  readonly favicon?: string | null;
  /** DCI-hosted logo from the profile hero, if any. */
  readonly logo?: string | null;
  /** DCI-hosted cover/banner image, if any. */
  readonly coverImage?: string | null;
}

export interface DiscoverOptions {
  readonly season: number;
  readonly fetchHtml: FetchHtml;
  readonly refresh?: boolean;
  readonly ttlMs?: number;
  /** Cap profiles probed (each may try a few slug variants). */
  readonly limit?: number;
  readonly includeDefunct?: boolean;
}

// For each competing corps without an archived profile, try slug variants until
// one resolves to a real profile (archiving every probe). Returns what was found.
export const discoverCorpsProfiles = (
  options: DiscoverOptions
): Effect.Effect<readonly DiscoveredCorps[], SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const competing = yield* (listCompetingCorps(options.season));
    const historical = options.includeDefunct ? yield* (loadHistoricalCorpsFromSnapshots(sql)) : [];
    const historicalNames = new Set(historical.map((c) => normalizeNameKey(c.unitName)));

    const candidatesByName = new Map<string, CompetingCorps>();
    const shouldKeepCurrentCandidate = (c: CompetingCorps) =>
      c.corpsKey != null || c.divisionName != null || historicalNames.has(normalizeNameKey(c.unitName));

    for (const c of [...historical, ...competing.filter(shouldKeepCurrentCandidate)]) {
      const key = normalizeNameKey(c.unitName);
      if (!key || candidatesByName.has(key)) continue;
      candidatesByName.set(key, c);
    }

    const candidates = Array.from(candidatesByName.values()).filter((c) => !c.hasBeenIngested);
    const capped = options.limit ? candidates.slice(0, options.limit) : candidates;

    const out: DiscoveredCorps[] = [];
    for (const c of capped) {
      const slugs = guessCorpsSlugs(c.unitName, c.existingSlug);
      const tried: string[] = [];
      let found: DiscoveredCorps | null = null;
      for (const slug of slugs) {
        tried.push(slug);
        const r = yield* (
          probeCorpsProfile(slug, {
            fetchHtml: options.fetchHtml,
            refresh: options.refresh,
            ttlMs: options.ttlMs,
            allowWayback: true,
          })
        );
        if (r.isProfile) {
          const textDivision = r.html ? parseCorpsClassFromText(r.html) : null;
          // Favicon fallback only when the DCI page has no logo and we have the
          // corps' own site — fetch it once to read the icon link.
          let favicon: string | null = null;
          if (!r.profile?.logo && r.profile?.website) {
            const siteHtml = yield* (
              options.fetchHtml(r.profile.website).pipe(Effect.orElseSucceed(() => ''))
            );
            if (siteHtml) favicon = resolveFavicon(siteHtml, r.profile.website);
          }
          found = {
            unitName: c.unitName,
            corpsKey: c.corpsKey,
            slug,
            status: r.status,
            triedSlugs: [...tried],
            textDivision,
            favicon,
            logo: r.profile?.logo ?? null,
            coverImage: r.profile?.coverImage ?? null,
          };
          break;
        }
      }
      out.push(
        found ?? {
          unitName: c.unitName,
          corpsKey: c.corpsKey,
          slug: null,
          status: 404,
          triedSlugs: tried,
        }
      );
    }
    return out;
  });
