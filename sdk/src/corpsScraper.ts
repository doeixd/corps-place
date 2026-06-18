import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import {
  DIRECTORY_SCRAPE_SLUG,
  getLatestCorpsPageScrape,
  upsertCorpsPageScrape,
  type CorpsPageType,
} from './relational.js';
import {
  parseCorpsDirectory,
  parseCorpsProfile,
  type DirectoryRoster,
  type CorpsProfile,
} from './corpsParser.js';
import type { DciNetworkError } from './errors.js';

/**
 * dci.org corps page scraping (foundation / M1).
 *
 * Fetches corps pages through an injected `fetchHtml` (Browserbase in
 * production, so Cloudflare is bypassed) and archives every response — raw HTML
 * plus a `scraped_at` timestamp — in `corps_page_scrapes`. History is kept in
 * full, so any past snapshot can be replayed/re-parsed (time travel).
 *
 * Caching is staleness-based: a recent archived scrape short-circuits the fetch,
 * so repeated runs don't re-hit Browserbase. Pass `refresh` to force a re-fetch.
 */

// dci.org serves WordPress with canonical *trailing-slash* URLs; the directory
// is the class-grouped roster, profiles are `/corps/<slug>/`.
const CORPS_BASE = 'https://www.dci.org/corps';

export const corpsDirectoryUrl = () => `${CORPS_BASE}/`;
export const corpsProfileUrl = (slug: string) => `${CORPS_BASE}/${slug}/`;

export type FetchHtml = (url: string) => Effect.Effect<string, DciNetworkError, never>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

const isFresh = (scrapedAt: string, ttlMs: number) => {
  const at = Date.parse(scrapedAt);
  return Number.isFinite(at) && Date.now() - at < ttlMs;
};

export interface CorpsPageResult {
  readonly slug: string;
  readonly pageType: CorpsPageType;
  readonly url: string;
  readonly html: string;
  readonly scrapedAt: string;
  /** True when served from the archive cache rather than a fresh fetch. */
  readonly fromCache: boolean;
}

export interface ScrapeCorpsPageOptions {
  readonly fetchHtml: FetchHtml;
  /** Omit for the directory page; provide a slug for a profile page. */
  readonly slug?: string;
  /** Re-fetch even if a fresh archived scrape exists. */
  readonly refresh?: boolean;
  /** Cache lifetime; an archived scrape newer than this is reused. */
  readonly ttlMs?: number;
}

// Fetch (or replay from the archive) one corps page, archiving any fresh fetch.
export const scrapeCorpsPage = (
  options: ScrapeCorpsPageOptions
): Effect.Effect<CorpsPageResult, DciNetworkError | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const pageType: CorpsPageType = options.slug ? 'profile' : 'directory';
    const cacheSlug = options.slug ?? DIRECTORY_SCRAPE_SLUG;
    const url = options.slug ? corpsProfileUrl(options.slug) : corpsDirectoryUrl();
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    if (!options.refresh) {
      const cached = yield* (getLatestCorpsPageScrape(sql, cacheSlug));
      if (cached && cached.rawHtml && isFresh(cached.scrapedAt, ttlMs)) {
        yield* (Effect.logInfo(`[corps] cache hit ${cacheSlug} (${cached.scrapedAt})`));
        return {
          slug: cacheSlug,
          pageType,
          url,
          html: cached.rawHtml,
          scrapedAt: cached.scrapedAt,
          fromCache: true,
        };
      }
    }

    yield* (Effect.logInfo(`[corps] fetching ${url}`));
    const html = yield* (options.fetchHtml(url));
    const scrapedAt = new Date().toISOString();
    yield* (
      upsertCorpsPageScrape(sql, {
        corpsSlug: cacheSlug,
        pageType,
        sourceUrl: url,
        httpStatus: 200,
        rawHtml: html,
        scrapedAt,
        // parsed_json filled in by the parser stage (M2/M3); archive raw now.
      })
    );
    return { slug: cacheSlug, pageType, url, html, scrapedAt, fromCache: false };
  });

export interface CorpsDirectoryResult extends CorpsPageResult {
  readonly roster: DirectoryRoster;
}

// Fetch (or replay) the `/corps/` roster, parse it, and persist the parsed roster
// into the same archive row's `parsed_json` (idempotent for that scrape time, so
// re-parsing backfills/updates without a new fetch).
export const scrapeCorpsDirectory = (
  options: Omit<ScrapeCorpsPageOptions, 'slug'>
): Effect.Effect<CorpsDirectoryResult, DciNetworkError | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const page = yield* (scrapeCorpsPage(options));
    const roster = parseCorpsDirectory(page.html);
    yield* (
      upsertCorpsPageScrape(sql, {
        corpsSlug: DIRECTORY_SCRAPE_SLUG,
        pageType: 'directory',
        sourceUrl: page.url,
        httpStatus: 200,
        rawHtml: page.html,
        parsed: roster,
        scrapedAt: page.scrapedAt,
      })
    );
    return { ...page, roster };
  });

export interface CorpsProfileResult extends CorpsPageResult {
  readonly profile: CorpsProfile;
}

// Fetch (or replay) a corps profile page, parse it, and persist the parsed
// profile into the archive row's `parsed_json` (idempotent for that scrape time).
export const scrapeCorpsProfile = (
  slug: string,
  options: Omit<ScrapeCorpsPageOptions, 'slug'>
): Effect.Effect<CorpsProfileResult, DciNetworkError | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const page = yield* (scrapeCorpsPage({ ...options, slug }));
    const profile = parseCorpsProfile(page.html);
    yield* (
      upsertCorpsPageScrape(sql, {
        corpsSlug: slug,
        pageType: 'profile',
        sourceUrl: page.url,
        httpStatus: 200,
        rawHtml: page.html,
        parsed: profile,
        scrapedAt: page.scrapedAt,
      })
    );
    return { ...page, profile };
  });

export interface ClassChange {
  readonly slug: string;
  readonly name: string;
  readonly from: string | null;
  readonly to: string;
}

export interface DirectoryClassDiff {
  readonly agree: number;
  readonly changes: readonly ClassChange[];
  /** Roster slugs with no matching `corps.slug` (resolve by name/alias at ingest). */
  readonly unmatchedSlugs: readonly string[];
}

// Compare the parsed roster's divisions against current `corps.division_name`
// (matched by slug) so class changes can be reviewed before any write.
export const diffDirectoryClasses = (
  roster: DirectoryRoster
): Effect.Effect<DirectoryClassDiff, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<{ slug: string; division_name: string | null }>`
        SELECT slug, division_name FROM corps WHERE slug IS NOT NULL
      `
    );
    const bySlug = new Map(rows.map((r) => [r.slug, r.division_name]));
    let agree = 0;
    const changes: ClassChange[] = [];
    const unmatchedSlugs: string[] = [];
    for (const c of roster.corps) {
      if (!bySlug.has(c.slug)) {
        unmatchedSlugs.push(c.slug);
        continue;
      }
      const current = bySlug.get(c.slug) ?? null;
      if (current === c.division) agree++;
      else changes.push({ slug: c.slug, name: c.name, from: current, to: c.division });
    }
    return { agree, changes, unmatchedSlugs };
  });
