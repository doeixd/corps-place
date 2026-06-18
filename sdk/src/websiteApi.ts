import { Effect, Layer, Schema, Stream, Option } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import * as cheerio from 'cheerio';

import { mergeConfig, type DciSdkConfigOverrides } from './config.js';
import * as Domain from './domain.js';
import { DciNetworkError } from './errors.js';
import { DciApi } from './service.js';
import type {
  CompetitionsQuery,
  EventsQuery,
  GalleriesQuery,
  PaginatedListOptions,
  PerformanceCorpsQuery,
  PerformancesQuery,
  WarmCacheInstruction,
} from './service.js';
import {
  parseRecapHtml,
  parseScoresListHtml,
  WebsiteRecapParseError,
  scoresListUrl,
  recapUrl,
} from './websiteRecap.js';
import { upsertApiResponse, upsertWebsiteRecap } from './relational.js';

const AJAX_BASE = 'https://www.dci.org/wp-admin/admin-ajax.php';

/* ------------------------------------------------------------------ */
/*  Cache helpers                                                       */
/* ------------------------------------------------------------------ */

/** Cache TTL in milliseconds (7 days) */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const isStale = (fetchedAt: string): boolean => {
  const fetched = new Date(fetchedAt).getTime();
  return Date.now() - fetched > CACHE_TTL_MS;
};

/** Read a cached AJAX response from api_responses */
const getCachedAjaxResponse = (
  sql: SqlClient.SqlClient,
  endpointUrl: string
): Effect.Effect<Option.Option<{ responseJson: string; fetchedAt: string }>, never, never> =>
  Effect.gen(function* () {
    const rows = yield* (
      sql<{ response_json: string; fetched_at: string }>`
        SELECT response_json, fetched_at
        FROM api_responses
        WHERE endpoint_url = ${endpointUrl}
      `.pipe(
        Effect.catch(() => Effect.succeed([] as { response_json: string; fetched_at: string }[]))
      )
    );
    if (rows.length === 0) return Option.none();
    return Option.some({ responseJson: rows[0].response_json, fetchedAt: rows[0].fetched_at });
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

/** Store a website/API response in api_responses. The column name is historical;
 * website HTML is stored here too so successful fetches are replayable.
 */
const cacheAjaxResponse = (
  sql: SqlClient.SqlClient,
  endpointUrl: string,
  endpointType: string,
  responseJson: string,
  season?: string,
  recordCount?: number
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* (
      upsertApiResponse(sql, endpointUrl, endpointType, responseJson, { season, recordCount }).pipe(
        Effect.catch((e) =>
          Effect.logWarning(`Failed to cache AJAX response for ${endpointUrl}: ${String(e)}`)
        )
      )
    );
  }).pipe(Effect.catch(() => Effect.void));

/** Read a cached website recap from website_recaps */
const getCachedWebsiteRecap = (
  sql: SqlClient.SqlClient,
  slug: string
): Effect.Effect<
  Option.Option<{ rawHtml: string; season: string; scrapedAt: string }>,
  never,
  never
> =>
  Effect.gen(function* () {
    const rows = yield* (
      sql<{ raw_html: string; season: string; scraped_at: string }>`
        SELECT raw_html, season, scraped_at
        FROM website_recaps
        WHERE recap_slug = ${slug}
        ORDER BY scraped_at DESC
        LIMIT 1
      `.pipe(
        Effect.catch(() =>
          Effect.succeed([] as { raw_html: string; season: string; scraped_at: string }[])
        )
      )
    );
    if (rows.length === 0) return Option.none();
    return Option.some({
      rawHtml: rows[0].raw_html,
      season: rows[0].season,
      scrapedAt: rows[0].scraped_at,
    });
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

/** Store a website recap in website_recaps */
const cacheWebsiteRecap = (
  sql: SqlClient.SqlClient,
  slug: string,
  season: string,
  rawHtml: string,
  recap: Domain.WebsiteRecap
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* (
      upsertWebsiteRecap(sql, {
        slug,
        season,
        sourceUrl: recapUrl(slug),
        scrapedAt: new Date().toISOString(),
        rawHtml,
        recap,
      }).pipe(
        Effect.catch((e) =>
          Effect.logWarning(`Failed to cache website recap for ${slug}: ${String(e)}`)
        )
      )
    );
  }).pipe(Effect.catch(() => Effect.void));

/* ------------------------------------------------------------------ */
/*  HTTP helpers (shared with websiteScraper.ts conventions)            */
/* ------------------------------------------------------------------ */

const requestHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const maxRetries = 6;
const retryDelayMs = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoffDelay = (attempt: number) => retryDelayMs * 2 ** attempt;

const fetchHtmlWithRetry = async (url: string, attempt = 0): Promise<string> => {
  let response: Response;
  try {
    response = await fetch(url, { headers: requestHeaders });
  } catch (error) {
    if (attempt < maxRetries) {
      await sleep(backoffDelay(attempt));
      return fetchHtmlWithRetry(url, attempt + 1);
    }
    throw new WebsiteRecapParseError(`Failed to fetch ${url}: ${String(error)}`, {
      attempts: attempt + 1,
    });
  }

  const shouldRetry = response.status === 429 || response.status >= 500;
  if (shouldRetry && attempt < maxRetries) {
    await sleep(backoffDelay(attempt));
    return fetchHtmlWithRetry(url, attempt + 1);
  }

  if (!response.ok) {
    throw new WebsiteRecapParseError(`Failed to fetch ${url}: ${response.status}`, {
      status: response.status,
      attempts: attempt + 1,
    });
  }

  return response.text();
};

const fetchHtmlEffect = (url: string): Effect.Effect<string, DciNetworkError, never> =>
  Effect.tryPromise({
    try: () => fetchHtmlWithRetry(url),
    catch: (error) =>
      new DciNetworkError({
        message: error instanceof WebsiteRecapParseError ? error.message : String(error),
        statusCode: 0,
        cause: error,
      }),
  });

/* ------------------------------------------------------------------ */
/*  AJAX helpers                                                        */
/* ------------------------------------------------------------------ */

const postAjax = (action: string, params: Record<string, string | number>) =>
  Effect.tryPromise({
    try: async () => {
      const body = new URLSearchParams();
      body.append('action', action);
      for (const [k, v] of Object.entries(params)) {
        body.append(k, String(v));
      }
      const res = await fetch(AJAX_BASE, {
        method: 'POST',
        headers: {
          'User-Agent': requestHeaders['User-Agent'],
          Accept: '*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://www.dci.org',
          Referer: 'https://www.dci.org/events/',
        },
        body: body.toString(),
      });
      const text = await res.text();
      if (res.status === 403) {
        throw new Error(`DCI website firewall blocked request (403): ${text.slice(0, 200)}`);
      }
      return { status: res.status, text };
    },
    catch: (cause) =>
      new DciNetworkError({
        message: String(cause),
        statusCode: 0,
        cause,
      }),
  });

/* ------------------------------------------------------------------ */
/*  Event schedule — AJAX + HTML fallback                             */
/* ------------------------------------------------------------------ */

const monthMap: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

const parseEventCardDate = (dateText: string, season: string): Date | undefined => {
  const match = dateText
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]{3})$/);
  if (!match) return undefined;
  const day = match[1]!.padStart(2, '0');
  const month = monthMap[match[2]!];
  if (!month) return undefined;
  return new Date(`${season}-${month}-${day}`);
};

const parseLocation = (locationText: string): { city?: string; state?: string } => {
  const parts = locationText.split(',').map((s) => s.trim());
  if (parts.length >= 2) {
    return { city: parts[0], state: parts[parts.length - 1] };
  }
  return { city: locationText, state: undefined };
};

interface EventCard {
  slug: string;
  name: string;
  startDate: Date;
  locationCity?: string;
  locationState?: string;
  webStartTime?: string;
  buyTicketsLink?: string;
  watchLiveLink?: string;
  eventImage?: string;
}

interface EventPageParseResult {
  cards: EventCard[];
  currentPage: number;
  totalPages: number;
  source: 'ajax' | 'html';
}

const parseEventCardsFromHtml = (html: string, season: string): EventCard[] => {
  const $ = cheerio.load(html);
  const cards: EventCard[] = [];

  $('.upcoming-events .upcoming-events-box').each((_, element) => {
    const box = $(element);
    const nameLink = box.find('h4 a, .h4 a, p.h4 a').first();
    const name = nameLink.text().trim();
    const href = nameLink.attr('href') ?? '';
    const slugMatch = href.match(/\/events\/([^/]+)\/?$/);
    const slug = slugMatch ? slugMatch[1] : '';

    const dateText = box.find('ul.upcoming-events-contact li:nth-child(1) span').text().trim();
    const locationText = box.find('ul.upcoming-events-contact li:nth-child(2) span').text().trim();
    const timeText = box.find('ul.upcoming-events-contact li:nth-child(3) span').text().trim();

    const startDate = parseEventCardDate(dateText, season);
    const location = parseLocation(locationText);

    const buyTicketsLink = box.find('.upcoming-events-buy-tickets a.btn').attr('href') ?? undefined;
    const watchLiveLink =
      box.find('.upcoming-events-buy-tickets a[aria-label*="live stream"]').attr('href') ??
      undefined;
    const eventImage = box.find('.upcoming-events-img > img').attr('src') ?? undefined;

    if (slug && name && startDate) {
      cards.push({
        slug,
        name,
        startDate,
        locationCity: location.city,
        locationState: location.state,
        webStartTime: timeText,
        buyTicketsLink,
        watchLiveLink,
        eventImage,
      });
    }
  });

  return cards;
};

const parsePaginationTotalPages = (html: string): number => {
  const $ = cheerio.load(html);
  const totals = $('.info .total, #pagination .total')
    .map((_, element) => Number($(element).text().trim()))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  const linkPages = $('a.pagination-link[data-page]')
    .map((_, element) => Number($(element).attr('data-page')))
    .get()
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, ...totals, ...linkPages);
};

const parseEventsAjaxPayload = (
  responseText: string,
  season: string,
  page: number
): EventPageParseResult | undefined => {
  try {
    const json = JSON.parse(responseText) as { html?: string; pagination?: string };
    const html = json.html ?? '';
    const pagination = json.pagination ?? '';
    const cards = parseEventCardsFromHtml(html, season);
    return {
      cards,
      currentPage: page,
      totalPages: parsePaginationTotalPages(pagination || html),
      source: 'ajax',
    };
  } catch {
    return undefined;
  }
};

const parseEventsHtmlPage = (html: string, season: string, page: number): EventPageParseResult => ({
  cards: parseEventCardsFromHtml(html, season),
  currentPage: page,
  totalPages: parsePaginationTotalPages(html),
  source: 'html',
});

const uniqueEventCards = (cards: EventCard[]) => {
  const seen = new Set<string>();
  const unique: EventCard[] = [];
  for (const card of cards) {
    if (seen.has(card.slug)) continue;
    seen.add(card.slug);
    unique.push(card);
  }
  return unique;
};

const cacheParsedEventPage = (
  sql: SqlClient.SqlClient,
  endpointUrl: string,
  endpointType: string,
  parsed: EventPageParseResult,
  season: string
): Effect.Effect<void, never, never> =>
  cacheAjaxResponse(
    sql,
    `${endpointUrl}#parsed`,
    endpointType,
    JSON.stringify({
      parsed_at: new Date().toISOString(),
      current_page: parsed.currentPage,
      total_pages: parsed.totalPages,
      source: parsed.source,
      cards: parsed.cards,
    }),
    season,
    parsed.cards.length
  );

const fetchEventsViaAjax = (
  season: string,
  sql: SqlClient.SqlClient
): Effect.Effect<EventCard[], never, never> => {
  const fetchPage = (page: number): Effect.Effect<EventPageParseResult | undefined, never, never> =>
    Effect.gen(function* () {
      const cacheUrl = `${AJAX_BASE}?action=load_events&page=${page}`;
      const cached = yield* (getCachedAjaxResponse(sql, cacheUrl));
      if (Option.isSome(cached) && !isStale(cached.value.fetchedAt)) {
        const parsed = parseEventsAjaxPayload(cached.value.responseJson, season, page);
        if (parsed) {
          yield* (cacheParsedEventPage(sql, cacheUrl, 'load_events_parsed', parsed, season));
          return parsed;
        }
      }

      const result = yield* (
        postAjax('load_events', {
          page,
          'filters[corps]': '',
          'filters[location_state]': '',
          'filters[start_date]': '',
          'filters[end_date]': '',
        }).pipe(Effect.catch(() => Effect.succeed({ status: 0, text: '' })))
      );

      if (result.status >= 400 || !result.text) return undefined;

      const parsed = parseEventsAjaxPayload(result.text, season, page);

      // Cache only successful, parseable responses. Failed/firewall responses are
      // intentionally not cached over a previous good page.
      if (parsed) {
        yield* (
          cacheAjaxResponse(
            sql,
            cacheUrl,
            'load_events_raw',
            result.text,
            season,
            parsed.cards.length
          )
        );
        yield* (cacheParsedEventPage(sql, cacheUrl, 'load_events_parsed', parsed, season));
      }

      return parsed;
    });

  return Effect.gen(function* () {
    let all: EventCard[] = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, 200); page++) {
      const parsed = yield* (fetchPage(page));
      if (!parsed || parsed.cards.length === 0) break;
      totalPages = Math.max(totalPages, parsed.totalPages);
      all = all.concat(parsed.cards);
      yield* (Effect.sleep('300 millis'));
    }
    return uniqueEventCards(all);
  });
};

/** Fallback: scrape event schedule directly from /events/ HTML pages */
const fetchEventsViaHtml = (
  season: string,
  sql: SqlClient.SqlClient,
  fetchHtml = fetchHtmlEffect
): Effect.Effect<EventCard[], never, never> =>
  Effect.gen(function* () {
    const url = `https://www.dci.org/events/`;
    const loadHtmlPage = (page: number, pageUrl: string) =>
      Effect.gen(function* () {
        const cached = yield* (getCachedAjaxResponse(sql, pageUrl));
        let html: string;
        if (Option.isSome(cached) && !isStale(cached.value.fetchedAt)) {
          html = cached.value.responseJson;
        } else {
          html = yield* (fetchHtml(pageUrl).pipe(Effect.catch(() => Effect.succeed(''))));
          if (html) {
            yield* (cacheAjaxResponse(sql, pageUrl, 'website_events_html_raw', html, season));
          }
        }
        if (!html) return undefined;
        const parsed = parseEventsHtmlPage(html, season, page);
        yield* (cacheParsedEventPage(sql, pageUrl, 'website_events_html_parsed', parsed, season));
        return parsed;
      });

    const firstPage = yield* (loadHtmlPage(1, url));
    if (!firstPage) return [] as EventCard[];

    let all = firstPage.cards;
    const totalPages = Math.min(firstPage.totalPages, 200);
    for (let page = 2; page <= totalPages; page++) {
      const parsed = yield* (loadHtmlPage(page, `${url}?page=${page}`));
      if (!parsed || parsed.cards.length === 0) break;
      all = all.concat(parsed.cards);
      yield* (Effect.sleep('500 millis'));
    }
    all = uniqueEventCards(all);
    if (firstPage.totalPages > 1 && all.length <= firstPage.cards.length) {
      yield* (
        Effect.logWarning(
          `DCI events HTML exposes ${firstPage.totalPages} pages, but direct HTML pagination returned only page 1; AJAX/browser pagination is required for a cold full-season ingest.`
        )
      );
    }
    return all;
  }).pipe(Effect.catch(() => Effect.succeed([] as EventCard[])));

/* ------------------------------------------------------------------ */
/*  Competitions / Score events — AJAX + HTML fallback                */
/* ------------------------------------------------------------------ */

const parseScoreRowsFromHtml = (
  html: string
): Array<{
  slug: string;
  name: string;
  date: Date;
  location: string;
  scoresLink: string;
}> => {
  const $ = cheerio.load(html);
  const rows: Array<{
    slug: string;
    name: string;
    date: Date;
    location: string;
    scoresLink: string;
  }> = [];

  $('.tbl-row .row').each((_, element) => {
    const row = $(element);
    const name = row.find('.h6.fg-primary-100').text().trim();
    const dateText = row.find('.col-md-2 p').text().trim();
    const location = row.find('.col-md-3 p').text().trim();
    const link = row.find('a.arrow-btn').attr('href');

    if (name && link) {
      const slugMatch = link.match(/\/scores\/final-scores\/(.+?)\/?$/);
      const slug = slugMatch ? slugMatch[1] : '';
      const date = new Date(dateText);
      if (slug && Number.isFinite(date.getTime())) {
        rows.push({ slug, name, date, location, scoresLink: link });
      }
    }
  });

  return rows;
};

const scoreRowToCompetition = (row: {
  slug: string;
  name: string;
  date: Date;
  location: string;
}): Domain.Competition => ({
  slug: row.slug,
  eventName: row.name,
  competitionGUID: '',
  competitionLevel: 0,
  location: row.location,
  date: row.date,
  chiefJudge: undefined,
  scoresReleased: true,
  recapReleased: false,
  categoryRecapReleased: false,
  seasonGUID: '',
  seasonName: String(row.date.getFullYear()),
  groupTypes: [],
});

const fetchScoreEventsViaAjax = (
  season: string,
  sql: SqlClient.SqlClient,
  fetchHtml = fetchHtmlEffect
): Effect.Effect<Domain.Competition[], never, never> =>
  Effect.gen(function* () {
    // First fetch the scores list page to extract the nonce
    const scoresPageHtml = yield* (
      fetchHtml(scoresListUrl(season, 1)).pipe(Effect.catch(() => Effect.succeed('')))
    );
    if (!scoresPageHtml) return [] as Domain.Competition[];

    const ajaxMatch = scoresPageHtml.match(
      /scoreEventAjax\s*=\s*\{[^}]*"ajax_url":"([^"]+)","nonce":"([^"]+)"/
    );
    const wrapperMatch = scoresPageHtml.match(
      /id="score-pagination-wrapper"[^>]*data-post-type="([^"]+)"[^>]*data-posts-per-page="([^"]+)"/
    );

    if (!ajaxMatch || !wrapperMatch) {
      // No AJAX config found — fall through to HTML parsing
      return [] as Domain.Competition[];
    }

    const [, ajaxUrl, nonce] = ajaxMatch;
    const [, postType, postsPerPage] = wrapperMatch;

    let all: Domain.Competition[] = [];
    for (let page = 1; page <= 200; page++) {
      const cacheUrl = `${ajaxUrl}?action=score_events&nonce=${nonce}&post_type=${postType}&posts_per_page=${postsPerPage}&paged=${page}&filter_season=${season}`;
      const cached = yield* (getCachedAjaxResponse(sql, cacheUrl));
      let responseText: string;
      let responseStatus: number;

      if (Option.isSome(cached) && !isStale(cached.value.fetchedAt)) {
        responseText = cached.value.responseJson;
        responseStatus = 200;
      } else {
        const params = new URLSearchParams({
          action: 'score_events',
          nonce,
          post_type: postType,
          posts_per_page: postsPerPage,
          paged: String(page),
          filter_season: season,
          filter_location: '',
        });

        const res = yield* (
          Effect.tryPromise({
            try: () =>
              fetch(ajaxUrl, {
                method: 'POST',
                headers: {
                  ...requestHeaders,
                  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                },
                body: params.toString(),
              }).then(async (r) => ({ status: r.status, text: await r.text() })),
            catch: () => ({ status: 0, text: '' }),
          }).pipe(Effect.catch(() => Effect.succeed({ status: 0, text: '' })))
        );

        if (res.status === 403) {
          // Firewall block — stop AJAX and let HTML fallback handle it
          break;
        }
        if (res.status >= 400 || res.status === 0) break;

        responseText = res.text;
        responseStatus = res.status;

        // Cache the raw response
        yield* (cacheAjaxResponse(sql, cacheUrl, 'score_events', res.text, season));
      }

      try {
        const json = JSON.parse(responseText) as {
          success?: boolean;
          data?: { content?: string; current_page?: number; total_pages?: number };
        };
        if (!json.success || !json.data?.content) break;
        const rows = parseScoreRowsFromHtml(json.data.content);
        if (rows.length === 0) break;
        all = all.concat(rows.map(scoreRowToCompetition));
      } catch {
        break;
      }

      yield* (Effect.tryPromise(() => new Promise((r) => setTimeout(r, 300))));
    }

    return all;
  }).pipe(Effect.catch(() => Effect.succeed([] as Domain.Competition[])));

/** Fallback: parse the scores list page HTML directly (no AJAX) */
const fetchScoreEventsViaHtml = (
  season: string,
  fetchHtml = fetchHtmlEffect
): Effect.Effect<Domain.Competition[], never, never> =>
  Effect.gen(function* () {
    const url = scoresListUrl(season, 1);
    const html = yield* (fetchHtml(url).pipe(Effect.catch(() => Effect.succeed(''))));
    if (!html) return [] as Domain.Competition[];

    // Try to find the static score list table on the page
    const $ = cheerio.load(html);
    const rows: Domain.Competition[] = [];

    $('.tbl-row .row, .score-list .row, .scores-table tbody tr').each((_, element) => {
      const row = $(element);
      const name = row.find('.h6, .event-name, td:first-child').first().text().trim();
      const dateText = row.find('.date, td:nth-child(2)').first().text().trim();
      const location = row.find('.location, td:nth-child(3)').first().text().trim();
      const link = row.find("a.arrow-btn, a[href*='scores']").first().attr('href');

      if (name && dateText) {
        const slugMatch = link?.match(/\/scores\/final-scores\/(.+?)\/?$/);
        const slug = slugMatch ? slugMatch[1] : '';
        const date = new Date(dateText);
        if (slug && Number.isFinite(date.getTime())) {
          rows.push(scoreRowToCompetition({ slug, name, date, location }));
        }
      }
    });

    return rows;
  }).pipe(Effect.catch(() => Effect.succeed([] as Domain.Competition[])));

/* ------------------------------------------------------------------ */
/*  Individual recap scraping                                           */
/* ------------------------------------------------------------------ */

const fetchRecapViaHtml = (
  slug: string,
  sql: SqlClient.SqlClient,
  fetchHtml = fetchHtmlEffect
): Effect.Effect<Domain.CorpsScore[], never, never> =>
  Effect.gen(function* () {
    const cached = yield* (getCachedWebsiteRecap(sql, slug));
    let html: string;

    if (Option.isSome(cached) && !isStale(cached.value.scrapedAt)) {
      html = cached.value.rawHtml;
    } else {
      html = yield* (fetchHtml(recapUrl(slug)).pipe(Effect.catch(() => Effect.succeed(''))));
      if (!html) return [] as Domain.CorpsScore[];
    }

    const result = yield* (parseRecapHtml(html).pipe(Effect.catch(() => Effect.succeed(null))));

    if (!result) return [] as Domain.CorpsScore[];

    // Cache the recap if it was fetched live (not from cache) or if we want to refresh
    if (Option.isNone(cached) || isStale(cached.value.scrapedAt)) {
      const season = String(
        result.meta.date ? new Date(result.meta.date).getFullYear() : new Date().getFullYear()
      );
      yield* (
        cacheWebsiteRecap(sql, slug, season, html, result).pipe(Effect.catch(() => Effect.void))
      );
    }

    // Convert WebsiteRecap to CorpsScore[]
    const { classes, meta } = result;
    const scores: Domain.CorpsScore[] = [];

    for (const cls of classes) {
      for (const corps of cls.corps) {
        scores.push({
          groupName: corps.corpsName,
          divisionName: inferDivisionName(cls.className),
          orgGroupIdentifier: corps.corpsName,
          active: true,
          isOtherType: false,
          totalScore: corps.finalScore,
          subtotalScore: corps.subTotal,
          subtotalRank: undefined,
          round: '',
          rank: corps.finalRank,
          categories: [], // TODO: map from website recap
          competition: {
            slug,
            eventName: meta.title,
            competitionGUID: '',
            competitionLevel: 0,
            location: meta.location,
            date: new Date(meta.date),
            chiefJudge: meta.chiefJudge,
            scoresReleased: true,
            recapReleased: true,
            categoryRecapReleased: false,
            seasonGUID: '',
            seasonName: String(new Date(meta.date).getFullYear()),
            groupTypes: [],
          },
        });
      }
    }

    return scores;
  }).pipe(Effect.catch(() => Effect.succeed([] as Domain.CorpsScore[])));

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const inferDivisionName = (title: string): Domain.DivisionName => {
  const key = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (key.includes('all age')) return 'All Age Class';
  if (key.includes('soundsport')) return 'SoundSport';
  if (key.includes('international')) return 'International Class';
  if (key.includes('open class')) return 'Open Class';
  if (key.includes('world class')) return 'World Class';
  return 'World Class';
};

/* ------------------------------------------------------------------ */
/*  Card → Event mapper                                                 */
/* ------------------------------------------------------------------ */

const cardToEvent = (card: EventCard): Domain.Event => ({
  id: `web-${card.startDate.getFullYear()}-${card.slug}`,
  name: card.name,
  slug: card.slug,
  eventName: card.name,
  description: undefined,
  season: String(card.startDate.getFullYear()),
  year: String(card.startDate.getFullYear()),
  startTime: undefined,
  eDTStartTimeForAPI: '',
  fED: undefined,
  locationCity: card.locationCity,
  locationState: card.locationState,
  venueCity: undefined,
  venueState: undefined,
  timeZone: undefined,
  regionForWeb: undefined,
  buyTickets: card.buyTicketsLink,
  buyTicketsText: undefined,
  presentingSponsor: undefined,
  smallLogo: undefined,
  liveStreamLink: card.watchLiveLink,
  ticketsOnSale: undefined,
  eventImageThumb: card.eventImage,
  ticketWatermark: undefined,
  startDate: card.startDate,
  endDate: undefined,
  webStartTime: card.webStartTime,
  notesGeneral: undefined,
  notesLineupTimes: undefined,
  notesIndividualTickets: undefined,
  notesGroupTickets: undefined,
  minTicketPrice: undefined,
  maxTicketPrice: undefined,
  individualTicketsDisclaimer: undefined,
  groupTicketsDisclaimer: undefined,
  groupTicketThreshold: undefined,
  groupPrice1: undefined,
  groupPrice4: undefined,
  groupPrice5: undefined,
  groupPrice6: undefined,
  minGroupTicketPrice: undefined,
  maxGroupTicket: undefined,
  buyGroupTickets: undefined,
  eventImage: card.eventImage,
  ticketingMapImage: undefined,
  streetMapImage: undefined,
  metaDescription: undefined,
  metaTitle: undefined,
  categoryForWebCalendar: undefined,
  tOCEvent: undefined,
  entityType: undefined,
  schedules: [],
  participants: [],
  venue: undefined,
  venues: undefined,
  // All remaining fields undefined
  soundCheckTime: undefined,
  staffOffice: undefined,
  mealRoom: undefined,
  judgesLocation: undefined,
  suitesInUse: undefined,
  pressBox: undefined,
  marketingLocation: undefined,
  floMarchingLocation: undefined,
  tabulationLocation: undefined,
  eventCompTypePL: undefined,
  eventSpecial: undefined,
  contractDae: undefined,
  tEPContractDate: undefined,
  contractPriceText: undefined,
  x1stPayText: undefined,
  x2ndPtText: undefined,
  balanceDueText: undefined,
  sponsorLoadTime: undefined,
  mealInformation: undefined,
  waterStationLocation: undefined,
  sponsorReception: undefined,
  evacuationLocation: undefined,
  corpsParking: undefined,
  standstillCancellation: undefined,
  corpsFieldEntry: undefined,
  frontEnsembleFieldEntry: undefined,
  corpsFieldExit: undefined,
  frontEnsembleFieldExit: undefined,
  corpsWarmUpLocation: undefined,
  announcerLocation: undefined,
  propFieldEntry: undefined,
  propFieldExit: undefined,
  propStagingArea: undefined,
  tourEventPartnerContractStatus: undefined,
  ticketServiceAgreementStatus: undefined,
  staffParking: undefined,
  depositText: undefined,
  groupBusParking: undefined,
  yearbookSales: undefined,
  mainGateSouvenirSales: undefined,
  contestCoordinatorCell: undefined,
  parkingVerification: undefined,
  keyTimesVerification: undefined,
  corpsInfoVerification: undefined,
  keyLocationsVerification: undefined,
  eventSafetyInformation: undefined,
  seasonValues: undefined,
  bSA: undefined,
  bCA: undefined,
  bSTA: undefined,
  bPA: undefined,
  tEPName: undefined,
  printMarketplaceFootprintCommunity: undefined,
  printParkingLotFootprintCommunity: undefined,
  printPropsAndElectricalFootprintCom: undefined,
  printShowSheetCommunity: undefined,
});

/* ------------------------------------------------------------------ */
/*  Website scraper DciApi                                            */
/* ------------------------------------------------------------------ */

export interface WebsiteScraperOptions {
  overrides?: DciSdkConfigOverrides;
  /** Custom fetch function. Defaults to direct Node.js fetch. */
  fetchHtml?: (url: string) => Effect.Effect<string, DciNetworkError, never>;
}

export const makeWebsiteScraperDciApi = (options?: WebsiteScraperOptions) =>
  Effect.gen(function* () {
    const config = mergeConfig(options?.overrides);
    const sql = yield* (SqlClient.SqlClient);

    const localFetchHtml = options?.fetchHtml ?? fetchHtmlEffect;

    /**
     * Fetch events: tries AJAX first, falls back to direct HTML scraping.
     * AJAX responses are cached in api_responses.
     */
    const loadEvents = (season: string): Effect.Effect<EventCard[], never, never> =>
      fetchEventsViaAjax(season, sql).pipe(
        Effect.flatMap((cards) =>
          cards.length > 0 ? Effect.succeed(cards) : fetchEventsViaHtml(season, sql, localFetchHtml)
        )
      );

    /**
     * Fetch competitions: tries AJAX first, falls back to direct HTML scraping.
     * AJAX responses are cached in api_responses.
     */
    const loadCompetitions = (season: string): Effect.Effect<Domain.Competition[], never, never> =>
      fetchScoreEventsViaAjax(season, sql, localFetchHtml).pipe(
        Effect.flatMap((comps) =>
          comps.length > 0 ? Effect.succeed(comps) : fetchScoreEventsViaHtml(season, localFetchHtml)
        )
      );

    return DciApi.of({
      config,
      getSeasons: () =>
        Effect.gen(function* () {
          const currentYear = new Date().getFullYear();
          const seasons: string[] = [];
          for (let y = currentYear; y >= 2013; y--) {
            seasons.push(String(y));
          }
          return seasons;
        }),
      getCompetitions: (season: string) => loadCompetitions(season),
      listCompetitions: (query?: CompetitionsQuery) =>
        query?.season
          ? loadCompetitions(String(query.season))
          : Effect.succeed([] as readonly Domain.Competition[]),
      streamCompetitions: (query?: CompetitionsQuery) =>
        Stream.fromIterableEffect(
          query?.season
            ? loadCompetitions(String(query.season))
            : Effect.succeed([] as readonly Domain.Competition[])
        ),
      getCompetitionRecap: (slug: string) => fetchRecapViaHtml(slug, sql, localFetchHtml),
      getCorps: () =>
        Effect.fail(
          new DciNetworkError({
            message: 'getCorps is not supported by the website scraper API',
            statusCode: 0,
          })
        ),
      getPerformanceClasses: () =>
        Effect.succeed([
          'World Class',
          'Open Class',
          'All Age',
          'International',
          'SoundSport',
        ] as Domain.PerformanceClass[]),
      getPerformanceCorps: (_query?: PerformanceCorpsQuery) =>
        Effect.succeed([] as readonly string[]),
      getEventCorps: () => Effect.succeed({} as Record<string, string>),
      getEventRegions: () => Effect.succeed([] as readonly string[]),
      getEventStates: () => Effect.succeed([] as readonly string[]),
      listEvents: (query?: EventsQuery) =>
        query?.season
          ? loadEvents(String(query.season)).pipe(Effect.map((cards) => cards.map(cardToEvent)))
          : Effect.succeed([] as readonly Domain.Event[]),
      streamEvents: (query?: EventsQuery) =>
        Stream.fromIterableEffect(
          query?.season
            ? loadEvents(String(query.season)).pipe(Effect.map((cards) => cards.map(cardToEvent)))
            : Effect.succeed([] as readonly Domain.Event[])
        ),
      getCompetitionLocations: () => Effect.succeed([] as readonly string[]),
      listGalleries: (_query?: GalleriesQuery) => Effect.succeed([] as readonly Domain.Gallery[]),
      streamGalleries: (_query?: GalleriesQuery) =>
        Stream.empty as Stream.Stream<Domain.Gallery, never, never>,
      listPerformances: (_query: PerformancesQuery) =>
        Effect.succeed([] as readonly Domain.CorpsScore[]),
      streamPerformances: (_query: PerformancesQuery) =>
        Stream.empty as Stream.Stream<Domain.CorpsScore, never, never>,
      getPageContent: () => Effect.succeed([] as readonly Domain.PageContentEntry[]),
      getSponsors: () => Effect.succeed([] as readonly Domain.Sponsor[]),
      getPastChampions: () => Effect.succeed([] as readonly Domain.PastChampion[]),
      rawPaginated: <A, I>(_path: string, _schema: Schema.Codec<A, I>) =>
        Effect.succeed([] as readonly A[]),
      warmCache: (_instructions: WarmCacheInstruction[]) => Effect.void,
    });
  });

export const makeWebsiteScraperDciApiLayer = (overrides?: DciSdkConfigOverrides) =>
  Layer.effect(DciApi, makeWebsiteScraperDciApi({ overrides }));

export const DciApiWebsiteScraperLive = makeWebsiteScraperDciApiLayer();
