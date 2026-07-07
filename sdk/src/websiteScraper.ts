import { Duration, Effect, Option, Ref, Schedule } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Domain from "./domain.js";
import { BrowserbaseService } from "./browserbaseService.js";
import {
  buildCompetitionFromWebsiteRecap,
  buildCorpsScoresFromWebsiteRecap,
  parseRecapHtml,
  parseScoresListHtml,
  recapUrl,
  scoresListUrl,
  WebsiteRecapParseError,
  type CorpsDivisionMap
} from "./websiteRecap.js";
import {
  upsertWebsiteScoreList,
  upsertWebsiteRecap,
  ingestWebsiteRecap
} from "./relational.js";

export interface WebsiteScrapeOptions {
  readonly seasons?: ReadonlyArray<string>;
  readonly maxPages?: number;
  readonly concurrency?: number;
  readonly ingest?: boolean;
}

export interface WebsiteScrapeResult {
  readonly seasons: ReadonlyArray<string>;
  readonly scoreLists: number;
  readonly recaps: number;
  readonly corpsScores: number;
}

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const maxRetries = 6;
const retryDelayMs = 1000;
const dbRetrySchedule = Schedule.exponential(Duration.millis(500)).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered
);

const retryDb = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`[website] ${label} failed: ${String(error)}`)
    ),
    Effect.retry(dbRetrySchedule)
  );

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fetchHtmlWithRetry = async (url: string, attempt = 0): Promise<string> => {
  const response = await fetch(url, { headers: requestHeaders });
  const html = await response.text();
  if (response.status === 429 && attempt < maxRetries) {
    const delay = retryDelayMs * 2 ** attempt;
    await sleep(delay);
    return fetchHtmlWithRetry(url, attempt + 1);
  }
  if (!response.ok) {
    throw new WebsiteRecapParseError(`Failed to fetch ${url}: ${response.status}`);
  }
  return html;
};

interface ScoreEventsConfig {
  readonly pageUrl: string;
  readonly ajaxUrl: string;
  readonly nonce: string;
  readonly postType: string;
  readonly postsPerPage: string;
}

interface ScoreEventsResponse {
  readonly content: string;
  readonly currentPage: number;
  readonly totalPages: number;
}

// Returns the AJAX config when the scores page exposes it, or null when it
// doesn't (page shape changed, or a Cloudflare/bot challenge replaced the real
// page). Returning null instead of throwing lets the caller fall back to parsing
// the server-rendered scores-list HTML directly (review Medium #6).
const fetchScoreEventsConfig = async (season: string): Promise<ScoreEventsConfig | null> => {
  const pageUrl = scoresListUrl(season, 1);
  const html = await fetchHtmlWithRetry(pageUrl);
  const ajaxMatch = html.match(
    /scoreEventAjax\s*=\s*\{[^}]*"ajax_url":"([^"]+)","nonce":"([^"]+)"/
  );
  const wrapperMatch = html.match(
    /id="score-pagination-wrapper"[^>]*data-post-type="([^"]+)"[^>]*data-posts-per-page="([^"]+)"/
  );

  if (!ajaxMatch || !wrapperMatch) {
    return null;
  }

  const [, ajaxUrl, nonce] = ajaxMatch;
  const [, postType, postsPerPage] = wrapperMatch;

  return { pageUrl, ajaxUrl, nonce, postType, postsPerPage };
};

const fetchScoreEventsPage = async (
  config: ScoreEventsConfig,
  season: string,
  page: number
): Promise<ScoreEventsResponse> => {
  const params = new URLSearchParams({
    action: "score_events",
    nonce: config.nonce,
    post_type: config.postType,
    posts_per_page: config.postsPerPage,
    paged: String(page),
    filter_season: season,
    filter_location: ""
  });

  const response = await fetch(config.ajaxUrl, {
    method: "POST",
    headers: {
      ...requestHeaders,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new WebsiteRecapParseError(
      `Failed to fetch score events ${season}#${page}: ${response.status}`
    );
  }

  const json = (await response.json()) as {
    success: boolean;
    data?: { content: string; current_page: number; total_pages: number };
  };

  if (!json.success || !json.data) {
    throw new WebsiteRecapParseError(`Score events response missing data for ${season}#${page}`);
  }

  return {
    content: json.data.content,
    currentPage: json.data.current_page,
    totalPages: json.data.total_pages
  };
};

const fetchScoresListPage = (season: string, page: number, config: ScoreEventsConfig) =>
  Effect.tryPromise(() => fetchScoreEventsPage(config, season, page));

// Fetch a recap page by its exact URL (the href the scores-list row carried),
// rather than a slug-reconstructed `/scores/recap/<id>` URL. DCI sometimes
// serves recaps under a different path shape (e.g. `/scores/final-scores/...`),
// so following the row's own link is the reliable path; slug reconstruction is
// a fallback only (review Medium #7).
// DCI.org is behind Cloudflare, so a plain Node `fetch` of a recap page that
// isn't already cached returns a 403 challenge shell — which parses to zero
// class tables and used to abort the whole ingest run (2026-07-01 incident:
// the newly-released Northwest Youth Music Games recap never landed). Try the
// cheap plain fetch first; if it's blocked/empty, fall back to a browser render
// (remote Chrome → local Chromium → Browserbase) via BrowserbaseService, which
// clears the Cloudflare wall. The service is read through `Effect.serviceOption`
// so the scraper still runs (plain-fetch only) when the layer isn't provided.
const fetchRecapPageByUrl = (url: string) =>
  Effect.gen(function* () {
    // A plain fetch often *succeeds* against Cloudflare but returns a challenge
    // shell — either a small 403 body or a large 200 "Attention Required" page.
    // Both fetch fine yet contain no score tables, so the only reliable "was I
    // blocked?" signal is whether the HTML actually parses into a recap. Accept
    // the direct HTML only if it parses; otherwise fall back to a real browser
    // render (remote Chrome → local Chromium → Browserbase), which clears the
    // wall. The renderer is optional (serviceOption) so the scraper still runs
    // plain-fetch-only when the layer isn't provided.
    const direct = yield* Effect.tryPromise(() => fetchHtmlWithRetry(url)).pipe(
      Effect.catch(() => Effect.succeed(""))
    );
    if (direct.trim().length > 0) {
      const parsed = yield* parseRecapHtml(direct).pipe(Effect.result);
      if (parsed._tag === "Success") return direct;
      yield* Effect.logInfo(
        `[website] direct fetch for ${url} didn't parse (likely Cloudflare shell); trying browser render`
      );
    } else {
      yield* Effect.logInfo(
        `[website] direct fetch blocked/empty for ${url}; trying browser render`
      );
    }

    const renderer = yield* Effect.serviceOption(BrowserbaseService);
    if (Option.isSome(renderer)) {
      const rendered = yield* renderer.value
        .fetchHtml(url)
        .pipe(Effect.catch(() => Effect.succeed("")));
      if (rendered.trim().length > 0) {
        yield* Effect.logInfo(
          `[website] rendered ${url} — ${rendered.length} chars (Cloudflare bypass)`
        );
        return rendered;
      }
    }

    return yield* Effect.fail(
      new WebsiteRecapParseError(
        `Failed to fetch ${url}: blocked and no renderer produced a parseable recap`
      )
    );
  });

const parseScoresList = (html: string, season: string) =>
  parseScoresListHtml(html, season).pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof WebsiteRecapParseError
          ? error
          : new WebsiteRecapParseError("Failed to parse score list", error)
      )
    )
  );

const parseRecap = (html: string) =>
  parseRecapHtml(html).pipe(
    Effect.catch((error) =>
      Effect.fail(
        error instanceof WebsiteRecapParseError
          ? error
          : new WebsiteRecapParseError("Failed to parse recap", error)
      )
    )
  );

const differenceInDays = (later: Date, earlier: Date) =>
  Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

// Anchor the season end to the SCHEDULED finals (scheduledEnd), not the last
// *scored* recap. For a complete season these coincide; mid-season the last
// scored show would otherwise collapse seasonLength and pin percent_through
// toward 100 for every event (see relational.ts computeSeasonMeta).
const buildSeasonMeta = (
  competitions: ReadonlyArray<Domain.Competition>,
  scheduledEnd?: Date | undefined
) => {
  const sorted = [...competitions].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstDate = sorted[0]?.date;
  const lastScored = sorted[sorted.length - 1]?.date ?? firstDate;
  const lastDate =
    scheduledEnd && lastScored
      ? scheduledEnd > lastScored
        ? scheduledEnd
        : lastScored
      : (scheduledEnd ?? lastScored);
  const seasonLength =
    firstDate && lastDate ? Math.max(1, differenceInDays(lastDate, firstDate)) : 0;
  return { firstDate, lastDate, seasonLength };
};

const resolveScheduledSeasonEnd = (
  sql: SqlClient.SqlClient,
  season: string
): Effect.Effect<Date | undefined, unknown> =>
  sql<{ end_date: string | null }>`
    SELECT MAX(date(start_date)) AS end_date
    FROM events
    WHERE season = ${season}
  `.pipe(
    Effect.map((rows) => {
      const raw = rows[0]?.end_date;
      return raw ? new Date(`${raw}T00:00:00.000Z`) : undefined;
    }),
    Effect.orElseSucceed(() => undefined)
  );

const parseDivisionFromCorpsType = (type: string | null | undefined): Domain.DivisionName | undefined => {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower.includes("world class")) return "World Class";
  if (lower.includes("open class")) return "Open Class";
  if (lower.includes("all age") || lower.includes("all-age")) return "All Age Class";
  if (lower.includes("soundsport")) return "SoundSport";
  if (lower.includes("international")) return "International Class";
  return undefined;
};

const buildCorpsDivisionMapForSeason = (
  sql: SqlClient.SqlClient,
  season: string
): Effect.Effect<CorpsDivisionMap, unknown> =>
  Effect.gen(function* () {
    const divisionMap: { [corpsName: string]: Domain.DivisionName } = {};
    const seen = new Set<string>();

    // FIRST: Try to get authoritative division from corps.type field (from API)
    const corpsRows = yield* (
      sql<{
        name: string;
        type: string | null;
      }>`
        SELECT name, type
        FROM corps
        WHERE type IS NOT NULL
      `
    );

    for (const row of corpsRows) {
      const corpsName = row.name.toLowerCase().trim();
      const division = parseDivisionFromCorpsType(row.type);
      if (division && !seen.has(corpsName)) {
        divisionMap[corpsName] = division;
        seen.add(corpsName);
      }
    }

    yield* (
      Effect.logInfo(
        `[website] Loaded ${Object.keys(divisionMap).length} divisions from corps.type field`
      )
    );

    // SECOND: For corps not in the API, use most frequent division from current season
    const currentSeasonRows = yield* (
      sql<{
        corps_name: string;
        division_name: string;
        count: number;
      }>`
        SELECT
          corps_name,
          division_name,
          COUNT(*) as count
        FROM corps_scores
        WHERE competition_slug LIKE ${season + "-%"}
        GROUP BY corps_name, division_name
        ORDER BY corps_name, count DESC
      `
    );

    for (const row of currentSeasonRows) {
      const corpsName = row.corps_name.toLowerCase().trim();
      if (!seen.has(corpsName)) {
        divisionMap[corpsName] = row.division_name as Domain.DivisionName;
        seen.add(corpsName);
      }
    }

    yield* (
      Effect.logInfo(
        `[website] Built division map: ${Object.keys(divisionMap).length} corps total`
      )
    );

    // THIRD: If current season has no data (new season), try previous season
    if (Object.keys(divisionMap).length === seen.size) {
      // All corps came from corps table, no season data yet
      const prevSeason = String(parseInt(season) - 1);
      yield* (
        Effect.logInfo(`[website] No ${season} data yet, checking ${prevSeason} for unlisted corps`)
      );

      const prevSeasonRows = yield* (
        sql<{
          corps_name: string;
          division_name: string;
          count: number;
        }>`
          SELECT
            corps_name,
            division_name,
            COUNT(*) as count
          FROM corps_scores
          WHERE competition_slug LIKE ${prevSeason + "-%"}
          GROUP BY corps_name, division_name
          ORDER BY corps_name, count DESC
        `
      );

      for (const row of prevSeasonRows) {
        const corpsName = row.corps_name.toLowerCase().trim();
        if (!seen.has(corpsName)) {
          divisionMap[corpsName] = row.division_name as Domain.DivisionName;
          seen.add(corpsName);
        }
      }

      yield* (
        Effect.logInfo(
          `[website] Added ${seen.size - Object.keys(divisionMap).length} corps from ${prevSeason}`
        )
      );
    }

    return divisionMap;
  });

const scrapeScoresListPage = (
  sql: SqlClient.SqlClient,
  season: string,
  page: number,
  config: ScoreEventsConfig
) =>
  Effect.gen(function* () {
    const pageUrl = scoresListUrl(season, page);
    const response = yield* (fetchScoresListPage(season, page, config));
    const parsed = yield* (parseScoresList(response.content, season));

    yield* (
      retryDb(
        `score list page ${season}#${page}`,
        upsertWebsiteScoreList(sql, {
          season,
          page,
          sourceUrl: pageUrl,
          rawHtml: response.content,
          parsed,
          scrapedAt: new Date().toISOString()
        })
      )
    );

    return { entries: parsed.entries, totalPages: response.totalPages as number | undefined };
  });

// HTML fallback for one scores-list page: fetch the server-rendered page and
// parse its rows directly. Used when AJAX config is missing or an AJAX POST is
// blocked (review Medium #6). The page paginates via the same `page` query param
// as the AJAX endpoint; it exposes no reliable total-page count, so the caller
// stops once a page yields no new entries.
const scrapeScoresListPageHtml = (sql: SqlClient.SqlClient, season: string, page: number) =>
  Effect.gen(function* () {
    const pageUrl = scoresListUrl(season, page);
    const html = yield* (Effect.tryPromise(() => fetchHtmlWithRetry(pageUrl)));
    const parsed = yield* (parseScoresList(html, season));
    yield* (
      retryDb(
        `score list page (html) ${season}#${page}`,
        upsertWebsiteScoreList(sql, {
          season,
          page,
          sourceUrl: pageUrl,
          rawHtml: html,
          parsed,
          scrapedAt: new Date().toISOString()
        })
      )
    );
    return { entries: parsed.entries, totalPages: undefined as number | undefined };
  });

const scrapeWebsiteRecapByEntry = (
  sql: SqlClient.SqlClient,
  entry: Domain.WebsiteScoreListEntry,
  season: string,
  corpsDivisionMap?: CorpsDivisionMap
) =>
  Effect.gen(function* () {
    // Which URL actually carries the recap data changed in 2026: DCI's scores-list
    // rows now link to `/scores/final-scores/<slug>`, a summary-only SPA layout
    // (place / corps / total) that the recap parser can't read. The full judge +
    // subcaption breakdown still lives at `/scores/recap/<slug>` in the legacy
    // table format the parser understands. So try the `/scores/recap/` URL first
    // and fall back to the list href only for events served solely under that
    // path — using whichever candidate actually parses (review Medium #7 kept:
    // the list href is still honored, just no longer trusted blindly).
    const followedFromList =
      typeof entry.url === "string" && entry.url.startsWith("http");
    const candidates = [
      ...new Set(
        [recapUrl(entry.id), followedFromList ? entry.url : null].filter(
          (url): url is string => typeof url === "string"
        )
      )
    ];

    let chosen:
      | { url: string; html: string; recap: Domain.WebsiteRecap }
      | null = null;
    for (const url of candidates) {
      yield* Effect.logInfo(`[website] Fetching recap ${season}:${entry.id} ${url}`);
      const fetched = yield* fetchRecapPageByUrl(url).pipe(Effect.result);
      if (fetched._tag === "Failure") continue;
      const parsed = yield* parseRecap(fetched.success).pipe(Effect.result);
      if (parsed._tag === "Success") {
        chosen = { url, html: fetched.success, recap: parsed.success };
        break;
      }
      yield* Effect.logInfo(
        `[website] recap ${season}:${entry.id} at ${url} fetched but didn't parse; trying next candidate`
      );
    }

    if (chosen === null) {
      return yield* Effect.fail(
        new WebsiteRecapParseError(
          `No parseable recap for ${season}:${entry.id} (tried ${candidates.join(", ")})`
        )
      );
    }

    const { url: recapPageUrl, html, recap } = chosen;

    yield* (
      retryDb(
        `recap cache ${season}:${entry.id}`,
        upsertWebsiteRecap(sql, {
          slug: entry.id,
          season,
          sourceUrl: recapPageUrl,
          rawHtml: html,
          recap,
          scrapedAt: new Date().toISOString()
        })
      )
    );

    const competition = buildCompetitionFromWebsiteRecap(entry.id, recap, entry);
    const scores = buildCorpsScoresFromWebsiteRecap(competition, recap, corpsDivisionMap);

    yield* (
      Effect.logInfo(
        `[website] Parsed recap ${season}:${entry.id} corps scores: ${scores.length}`
      )
    );

    return {
      competition,
      scores,
      corpsScores: scores.length
    };
  });

const collectScoreListEntries = (
  sql: SqlClient.SqlClient,
  season: string,
  maxPages?: number
) =>
  Effect.gen(function* () {
    const entries: Domain.WebsiteScoreListEntry[] = [];
    const seen = new Set<string>();
    const config = yield* (Effect.tryPromise(() => fetchScoreEventsConfig(season)));
    if (!config) {
      yield* (
        Effect.logInfo(
          `[website] ${season}: scoreEventAjax config not found — using server-rendered HTML fallback for all pages`
        )
      );
    }
    let pagesScraped = 0;
    let page = 1;
    let totalPages: number | undefined;

    while (maxPages === undefined || page <= maxPages) {
      if (totalPages !== undefined && page > totalPages) {
        break;
      }
      const pageUrl = scoresListUrl(season, page);
      yield* (
        Effect.logInfo(
          `[website] Fetching scores page ${season}#${page} ${pageUrl} (${config ? 'ajax' : 'html'})`
        )
      );
      // AJAX when config is available, with a server-rendered-HTML fallback if the
      // AJAX POST is blocked/fails; pure HTML when there was no AJAX config at all
      // (review Medium #6).
      const ajaxConfig = config;
      const pageResult = ajaxConfig
        ? yield* (
            scrapeScoresListPage(sql, season, page, ajaxConfig).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* (
                    Effect.logInfo(
                      `[website] AJAX scores page ${season}#${page} failed (${error}); falling back to server-rendered HTML`
                    )
                  );
                  return yield* (scrapeScoresListPageHtml(sql, season, page));
                })
              )
            )
          )
        : yield* (scrapeScoresListPageHtml(sql, season, page));
      if (totalPages === undefined) {
        totalPages = pageResult.totalPages;
        yield* (
          Effect.logInfo(`[website] ${season} score list total pages: ${totalPages}`)
        );
      }
      if (pageResult.entries.length === 0) {
        yield* (
          Effect.logInfo(`[website] Scores page ${season}#${page} returned 0 entries; stopping.`)
        );
        break;
      }
      const newEntries = pageResult.entries.filter((entry) => !seen.has(entry.id));
      yield* (
        Effect.logInfo(
          `[website] Scores page ${season}#${page} entries: ${pageResult.entries.length}, new: ${newEntries.length}`
        )
      );
      pagesScraped += 1;
      newEntries.forEach((entry) => seen.add(entry.id));
      entries.push(...newEntries);
      page += 1;
    }

    return { entries, pagesScraped };
  });

export const scrapeWebsiteRecapsForSeason = (
  season: string,
  options: WebsiteScrapeOptions = {}
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const maxPages = options.maxPages;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 8));
    const ingest = options.ingest !== false;

    const entriesResult = yield* (collectScoreListEntries(sql, season, maxPages));
    yield* (
      Effect.logInfo(
        `[website] ${season} score list pages scraped: ${entriesResult.pagesScraped}`
      )
    );
    const unique = new Map(entriesResult.entries.map((entry) => [entry.id, entry]));
    yield* (
      Effect.logInfo(
        `[website] ${season} score list recaps found: ${entriesResult.entries.length} (unique: ${unique.size})`
      )
    );

    // Build corps division map for the season to handle mixed-division tables
    const corpsDivisionMap = yield* (buildCorpsDivisionMapForSeason(sql, season));

    const recapCountRef = yield* (Ref.make(0));
    const corpsCountRef = yield* (Ref.make(0));

    // Per-entry fault isolation: a single recap that fails to fetch/parse (e.g. a
    // brand-new event still behind Cloudflare with no working renderer) must not
    // sink the whole run — the other recaps should still ingest and publish. A
    // failed entry is logged and dropped (returns null → filtered out below).
    const recapResultsRaw = yield* (
      Effect.forEach(
        [...unique.values()],
        (entry) =>
          scrapeWebsiteRecapByEntry(sql, entry, season, corpsDivisionMap).pipe(
            Effect.tap(() => Ref.update(recapCountRef, (count) => count + 1)),
            Effect.tap((result) =>
              Ref.update(corpsCountRef, (count) => count + result.corpsScores)
            ),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(
                  `[website] recap ${season}:${entry.id} skipped — ${String(error)}`
                ),
                null
              )
            )
          ),
        { concurrency }
      )
    );
    const recapResults = recapResultsRaw.filter(
      (result): result is NonNullable<typeof result> => result !== null
    );

    if (ingest) {
      yield* (
        Effect.logInfo(`[website] Ingesting ${recapResults.length} recaps for ${season}`)
      );
      const scheduledEnd = yield* resolveScheduledSeasonEnd(sql, season);
      const seasonMeta = buildSeasonMeta(
        recapResults.map((result) => result.competition),
        scheduledEnd
      );
      yield* (
        Effect.forEach(
          recapResults,
          (result) =>
            retryDb(
              `ingest recap ${result.competition.slug ?? "unknown"}`,
              ingestWebsiteRecap(
                sql,
                {
                  season,
                  competition: result.competition,
                  scores: result.scores
                },
                {
                  seasonMeta,
                  scoreConcurrency: 4
                }
              )
            ),
          { concurrency }
        )
      );
      yield* (
        Effect.logInfo(`[website] Ingested ${recapResults.length} recaps for ${season}`)
      );
    } else {
      yield* (Effect.logInfo(`[website] Ingest disabled for ${season}`));
    }

    return {
      scoreLists: entriesResult.pagesScraped,
      recaps: yield* (Ref.get(recapCountRef)),
      corpsScores: yield* (Ref.get(corpsCountRef))
    };
  });

export const scrapeWebsiteRecaps = (options: WebsiteScrapeOptions = {}) =>
  Effect.gen(function* () {
    const seasons = options.seasons ?? [];
    const totals = {
      scoreLists: 0,
      recaps: 0,
      corpsScores: 0
    };

    for (const season of seasons) {
      const result = yield* (scrapeWebsiteRecapsForSeason(season, options));
      totals.scoreLists += result.scoreLists;
      totals.recaps += result.recaps;
      totals.corpsScores += result.corpsScores;
    }

    return {
      seasons,
      scoreLists: totals.scoreLists,
      recaps: totals.recaps,
      corpsScores: totals.corpsScores
    } satisfies WebsiteScrapeResult;
  });

export interface WebsiteRecapVerification {
  readonly slug: string;
  readonly topScores: ReadonlyArray<{ corpsName: string; rank: number; totalScore: number }>;
}

export const verifyWebsiteRecaps = (slugs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    return yield* (
      Effect.forEach(slugs, (slug) =>
        sql<{ corpsName: string; rank: number; totalScore: number }>`
          SELECT corps_name AS "corpsName", rank, total_score AS "totalScore"
          FROM corps_scores
          WHERE competition_slug = ${slug}
          ORDER BY rank
          LIMIT 3
        `.pipe(
          Effect.map((rows) => ({
            slug,
            topScores: rows
          }))
        )
      )
    );
  });

export const maybeRunWebsiteScrape = (
  season: string,
  options?: WebsiteScrapeOptions
) =>
  scrapeWebsiteRecapsForSeason(season, options).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning(
        `[scrape] website recap ${season} failed: ${error instanceof Error ? error.message : String(error)}`
      )
    )
  );
