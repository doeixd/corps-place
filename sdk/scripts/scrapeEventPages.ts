// Scrape current DCI event pages and persist lineups + metadata.
// Usage: npx tsx scripts/scrapeEventPages.ts [--slug=event-slug] [--season=2024] [--limit=50] [--offset=0]

import { Effect, Layer, Option } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as cheerio from "cheerio";
import {
  EventPageScrape,
  upsertEventPageScrape
} from "../src/relational.js";
import {
  BrowserbaseService,
  BrowserbaseServiceLive
} from "../src/browserbaseService.js";

if (typeof globalThis.File === "undefined") {
  const FilePolyfill = class {
    name: string;
    lastModified: number;

    constructor(_parts: unknown[], name: string, options?: { lastModified?: number }) {
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  };
  (globalThis as any).File = FilePolyfill;
}

const baseUrl = "https://www.dci.org/events";
const concurrency = 3;
const maxRetries = 8;
const retryBaseDelayMs = 1000;

const parseNumberFlag = (args: string[], flag: string) => {
  const prefix = `${flag}=`;
  const raw = args.find((arg) => arg.startsWith(prefix));
  if (!raw) return undefined;
  const value = Number(raw.slice(prefix.length));
  return Number.isFinite(value) ? value : undefined;
};

const parseStringFlag = (args: string[], flag: string) => {
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const cleanText = (value: string | undefined) => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const selectors = {
  date: ".inner-hero-inner p:nth-child(1)",
  title: ".inner-hero-inner h1",
  locationCityState: ".inner-hero-inner .location",
  watchLiveLink: ".buy-tickets-btn .watch-live",
  buyTicketsLink: ".buy-tickets-btn a.btn",
  about: ".left-section .common-dis > p",
  ticketsSection: ".upcoming-events",
  ticket: ".upcoming-events .upcoming-events-info",
  ticketTitle: ".upcoming-events-info .event-ticket-title",
  ticketDescription: ".upcoming-events-info .common-dis",
  ticketInfo: ".upcoming-events-info .event-ticket-info",
  ticketPrice: ".upcoming-events-info .event-ticket-price",
  ticketBuyLink: ".upcoming-events-info .arrow-link > a",
  lineupsSection: ".lineup-times-section",
  lineupsTable: ".lineup-times-section table",
  lineupRow: ".lineup-times-section table tr",
  eventLocationSection: ".event-location",
  eventLocationAddress: ".event-location address",
  eventLocationGoogleMapLink: ".event-location .event-info a",
  eventLocationGoogleMapIframe: ".event-location .event-location-maps iframe",
  eventLocationImages: ".event-location img"
};

interface EventPageResponse {
  readonly status: number;
  readonly url: string;
  readonly html: string;
}

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Hard per-request network timeout. Without this a stalled TCP read (Cloudflare/
// dci.org holding the connection open) blocks forever in ep_poll — the bug that
// hung a whole scrape for 4.7 days while holding the refresh-lineups flock.
// The signal aborts the body stream too, so `response.text()` can't hang either.
const FETCH_TIMEOUT_MS = 25000;

const fetchWithRetry = async (requestUrl: string, attempt = 0): Promise<EventPageResponse> => {
  const response = await fetch(requestUrl, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const html = await response.text();
  if (response.status === 429 && attempt < maxRetries) {
    const delay = retryBaseDelayMs * 2 ** attempt;
    console.warn(
      `Rate limited (429) for ${requestUrl}. Retry ${attempt + 1}/${maxRetries} ` +
        `after ${delay}ms.`
    );
    await sleep(delay);
    return fetchWithRetry(requestUrl, attempt + 1);
  }
  return { status: response.status, url: response.url, html } satisfies EventPageResponse;
};

const fetchJsonWithRetry = async <T>(requestUrl: string, attempt = 0): Promise<{
  status: number;
  data: T | null;
}> => {
  const response = await fetch(requestUrl, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 429 && attempt < maxRetries) {
    const delay = retryBaseDelayMs * 2 ** attempt;
    console.warn(
      `Rate limited (429) for ${requestUrl}. Retry ${attempt + 1}/${maxRetries} ` +
        `after ${delay}ms.`
    );
    await sleep(delay);
    return fetchJsonWithRetry<T>(requestUrl, attempt + 1);
  }
  if (response.status >= 400) {
    return { status: response.status, data: null };
  }
  const data = (await response.json()) as T;
  return { status: response.status, data };
};

// DCI.org is behind Cloudflare, so a plain fetch of an event page returns a
// challenge shell — a small 403 body or a 200 "Attention Required" page — with no
// lineup data. Detect that and fall back to a real browser render (remote Chrome →
// local Chromium → Browserbase) via BrowserbaseService, read through serviceOption
// so the script still runs (plain-fetch only) when the layer isn't provided.
// Mirrors the recap-scraper fix.
const looksBlocked = (status: number, html: string): boolean =>
  status === 403 ||
  status === 503 ||
  /Attention Required! \| Cloudflare|Just a moment\.\.\.|challenge-platform|__cf_chl|Enable JavaScript and cookies/i.test(
    html
  );

// A page is only "good" once it carries the lineup/schedule table. Used both to
// decide whether a plain fetch is enough and — passed into the renderer — to make
// a hydration-starved SPA shell (e.g. local Chromium returning a ~338-char body
// with no lineup) ESCALATE to Browserbase instead of being accepted and persisted
// with stale performance times. A genuinely-empty event (no lineup posted yet)
// simply never passes, so we fall back to best-effort and the caller's empty-page
// handling (overwrite guard) leaves existing data untouched.
const hasLineup = (html: string): boolean =>
  cheerio.load(html)(selectors.lineupRow).length > 0;

const getEventPage = (slug: string) =>
  Effect.gen(function* () {
    const requestUrl = `${baseUrl}/${slug}`;
    const direct = yield* Effect.tryPromise(() => fetchWithRetry(requestUrl));
    // Render when Cloudflare-blocked OR when a 200 came back without a lineup (an
    // un-hydrated shell) — either way the plain fetch isn't the real page.
    if (!looksBlocked(direct.status, direct.html) && hasLineup(direct.html)) return direct;

    const renderer = yield* Effect.serviceOption(BrowserbaseService);
    if (Option.isSome(renderer)) {
      const rendered = yield* renderer.value
        .fetchHtml(requestUrl, hasLineup)
        .pipe(Effect.catch(() => Effect.succeed("")));
      if (rendered.trim().length > 0) {
        return {
          status: 200,
          url: requestUrl,
          html: rendered
        } satisfies EventPageResponse;
      }
    }
    // Blocked and no renderer produced content — return the blocked response so
    // the caller's status handling (404→Wayback, ≥400→fail) still applies.
    return direct;
  });

const getWaybackPage = (slug: string) =>
  Effect.tryPromise(async () => {
    const targetUrl = `${baseUrl}/${slug}`;
    const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(
      targetUrl
    )}`;
    const availability = await fetchJsonWithRetry<{
      archived_snapshots?: { closest?: { available?: boolean; url?: string; status?: string } };
    }>(availabilityUrl);
    const snapshot = availability.data?.archived_snapshots?.closest;
    if (!snapshot?.available || !snapshot.url) {
      return null;
    }
    const page = await fetchWithRetry(snapshot.url);
    if (page.status >= 400) {
      return null;
    }
    return page;
  });

const parseTickets = ($: cheerio.CheerioAPI) =>
  $(selectors.ticket)
    .map((_, element) => {
      const node = $(element);
      const description = cleanText(node.find(selectors.ticketDescription).text());
      return {
        title: cleanText(node.find(selectors.ticketTitle).text()),
        description,
        info: cleanText(node.find(selectors.ticketInfo).text()),
        price: cleanText(node.find(selectors.ticketPrice).text()),
        buyLink: node.find(selectors.ticketBuyLink).attr("href")?.trim() || undefined
      };
    })
    .get();

const nonPerformanceLabels = new Set([
  "gates open",
  "welcome & national anthem",
  "welcome and national anthem",
  "intermission",
  "scores announced",
  "final scores announced",
  "special recognitions",
  "ultimate drill book recognition",
  "age-out ceremony",
  "age out ceremony",
  "retreat",
  "welcome",
  "preshow",
  "pre show",
  "pre-show",
  "announcements",
  "announcement",
  "encore",
  "change",
  "changeover",
  "score",
  "annouced",
  "givaway",
  "presentation",
  "spectators"
]);

const nonPerformanceKeywords = [
  "gates open",
  "intermission",
  "anthem",
  "scores announced",
  "final scores",
  "recognition",
  "ceremony",
  "age-out",
  "age out",
  "retreat",
  "welcome",
  "preshow",
  "pre show",
  "pre-show",
  "announcement",
  "encore",
  "change",
  "changeover",
  "score",
  "annouced",
  "givaway",
  "presentation",
  "spectator"
];

const normalizeLineupLabel = (value?: string) =>
  (value ?? "")
    .toLowerCase()
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isNonPerformanceLabel = (label: string) => {
  const normalized = normalizeLineupLabel(label);
  if (nonPerformanceLabels.has(normalized)) {
    return true;
  }
  return nonPerformanceKeywords.some((keyword) => normalized.includes(keyword));
};

const parseLineupCell = ($: cheerio.CheerioAPI, cell: cheerio.Cheerio<cheerio.Element>) => {
  const strongText = cleanText(cell.find("strong").first().text());
  const fullText = cleanText(cell.text());
  const label = strongText ?? fullText;
  if (!label) {
    return { corpsName: undefined, corpsCity: undefined, isNonPerformance: true };
  }

  const resolvedName = label;
  const baseLabel = label;

  if (isNonPerformanceLabel(baseLabel)) {
    return { corpsName: label, corpsCity: undefined, isNonPerformance: true };
  }

  if (strongText && fullText) {
    const remainder = fullText.replace(strongText, "").replace(/^\s*-\s*/g, "").trim();
    return {
      corpsName: resolvedName,
      corpsCity: cleanText(remainder) ?? undefined,
      isNonPerformance: false
    };
  }
  return { corpsName: resolvedName, corpsCity: undefined, isNonPerformance: false };
};

const parseLineupTime = (value?: string) => {
  if (!value) {
    return { time: undefined, order: undefined };
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  const parts = normalized.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2 && /^\d+$/.test(parts[0])) {
    return { order: Number(parts[0]), time: parts[1] };
  }
  return { time: normalized, order: undefined };
};

const parseLineup = ($: cheerio.CheerioAPI) =>
  $(selectors.lineupRow)
    .map((index, element) => {
      const row = $(element);
      const cells = row.find("td");
      if (cells.length < 2) {
        return undefined;
      }
      const timeCell = cleanText($(cells[0]).text());
      const parsedTime = parseLineupTime(timeCell);
      const parsed = parseLineupCell($, $(cells[1]));
      if (!parsedTime.time && !parsed.corpsName) {
        return undefined;
      }
      return {
        time: parsedTime.time,
        corpsName: parsed.corpsName,
        corpsCity: parsed.corpsCity,
        order: parsedTime.order ?? index,
        isNonPerformance: parsed.isNonPerformance
      };
    })
    .get()
    .filter((entry) => Boolean(entry));

interface EventPageScrapeDiagnostics {
  readonly lineupTableExists: boolean;
  readonly lineupRowCount: number;
  readonly ticketCount: number;
  readonly aboutHtmlLength: number;
  readonly htmlLength: number;
}

const parseEventPage = (slug: string, html: string, sourceUrl?: string) => {
  const $ = cheerio.load(html);
  const locationText = cleanText($(selectors.locationCityState).text());
  const aboutBlock = $(selectors.about).closest(".common-dis").first();
  const aboutHtmlRaw = aboutBlock.html()?.trim();
  const lineupRowCount = $(selectors.lineupRow).length;
  const lineupTableExists = $(selectors.lineupsTable).length > 0;
  const ticketCount = $(selectors.ticket).length;

  const scrape: EventPageScrape = {
    eventSlug: slug,
    eventDateText: cleanText($(selectors.date).text()),
    eventName: cleanText($(selectors.title).text()),
    locationText,
    watchLiveLink: $(selectors.watchLiveLink).attr("href")?.trim() || undefined,
    buyTicketsLink: $(selectors.buyTicketsLink).attr("href")?.trim() || undefined,
    about: cleanText($(selectors.about).first().text()),
    aboutHtml: aboutHtmlRaw && aboutHtmlRaw.length > 0 ? aboutHtmlRaw : undefined,
    tickets: parseTickets($),
    lineup: parseLineup($),
    locationAddress: cleanText($(selectors.eventLocationAddress).text()),
    locationGoogleMapLink:
      $(selectors.eventLocationGoogleMapLink).attr("href")?.trim() || undefined,
    locationGoogleMapIframe:
      $(selectors.eventLocationGoogleMapIframe).attr("src")?.trim() || undefined,
    heroImage: $(".hero-section img").first().attr("src")?.trim() || undefined,
    locationImages: $(selectors.eventLocationImages)
      .map((_, element) => $(element).attr("src")?.trim())
      .get()
      .filter((value) => Boolean(value)) as string[],
    scrapedAt: new Date().toISOString(),
    sourceUrl: sourceUrl ?? `${baseUrl}/${slug}`
  };

  const diagnostics: EventPageScrapeDiagnostics = {
    lineupTableExists,
    lineupRowCount,
    ticketCount,
    aboutHtmlLength: aboutHtmlRaw?.length ?? 0,
    htmlLength: html.length
  };

  return { scrape, diagnostics };
};

const fetchEventSlugs = (
  sql: SqlClient.SqlClient,
  season?: string,
  window?: { minDate: string; maxDate: string }
) => {
  // Scoped to an upcoming window (recently-passed + next N days) — for the daily
  // lineup-refresh cron, so it only re-scrapes events whose lineups can still
  // change, not the whole season. Compared on the date prefix (start_date is a
  // full ISO timestamp).
  if (season && window) {
    return sql<{ slug: string }>`
      SELECT slug
      FROM events
      WHERE slug IS NOT NULL
        AND (season = ${season} OR strftime('%Y', start_date) = ${season})
        AND substr(start_date, 1, 10) >= ${window.minDate}
        AND substr(start_date, 1, 10) <= ${window.maxDate}
      ORDER BY start_date
    `.pipe(Effect.map((rows) => rows.map((row) => row.slug)));
  }
  return season
    ? sql<{ slug: string }>`
        SELECT slug
        FROM events
        WHERE slug IS NOT NULL
          AND (
            season = ${season}
            OR strftime('%Y', start_date) = ${season}
          )
      `.pipe(Effect.map((rows) => rows.map((row) => row.slug)))
    : sql<{ slug: string }>`
        SELECT slug FROM events WHERE slug IS NOT NULL
      `.pipe(Effect.map((rows) => rows.map((row) => row.slug)));
};

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const slug = parseStringFlag(args, "--slug");
  const season = parseStringFlag(args, "--season");
  const limit = parseNumberFlag(args, "--limit");
  const offset = parseNumberFlag(args, "--offset") ?? 0;
  const overwrite = args.includes("--overwrite");
  const verbose = args.includes("--verbose");

  // Optional upcoming-window scoping (used by the lineup-refresh cron):
  // --upcoming-days=N restricts to events from --past-days ago (default 7) through
  // N days out. Only applies together with --season.
  const upcomingDays = parseNumberFlag(args, "--upcoming-days");
  const pastDays = parseNumberFlag(args, "--past-days") ?? 7;
  const window =
    upcomingDays != null
      ? {
          minDate: new Date(Date.now() - pastDays * 86400000)
            .toISOString()
            .slice(0, 10),
          maxDate: new Date(Date.now() + upcomingDays * 86400000)
            .toISOString()
            .slice(0, 10)
        }
      : undefined;
  if (window) {
    console.log(
      `Scoping to upcoming window ${window.minDate} … ${window.maxDate} (--upcoming-days=${upcomingDays}).`
    );
  }

  const sql = yield* (SqlClient.SqlClient);
  const slugs = slug ? [slug] : yield* (fetchEventSlugs(sql, season, window));
  const sliced = slugs.slice(offset, limit ? offset + limit : undefined);
  const startTime = Date.now();

  console.log(
    `Starting event page scrape for ${sliced.length} events ` +
      `(offset=${offset}, limit=${limit ?? "all"}, overwrite=${overwrite}).`
  );

  let processed = 0;
  let failed = 0;

  yield* (
    Effect.forEach(
      sliced,
      (eventSlug) =>
        Effect.gen(function* () {
          const result = yield* (
            Effect.gen(function* () {
              const response = yield* (getEventPage(eventSlug));
              let sourceLabel = "live";
              let payload = response;
              if (response.status === 404) {
                console.warn(
                  `Event page not found for ${eventSlug} (status=404). Trying Wayback...`
                );
                const wayback = yield* (getWaybackPage(eventSlug));
                if (!wayback) {
                  console.warn(`Wayback snapshot missing for ${eventSlug}.`);
                  return "not_found" as const;
                }
                console.log(`Wayback snapshot found for ${eventSlug}: ${wayback.url}`);
                sourceLabel = "wayback";
                payload = wayback;
              }
              if (payload.status === 429) {
                return yield* (Effect.fail(new Error(`Rate limited for ${eventSlug} (429).`)));
              }
              if (payload.status >= 400) {
                return yield* (
                  Effect.fail(new Error(`Bad status ${payload.status} for ${eventSlug}.`))
                );
              }
              const { scrape, diagnostics } = parseEventPage(
                eventSlug,
                payload.html,
                payload.url
              );
              const likelyEmpty =
                diagnostics.lineupRowCount === 0 &&
                diagnostics.ticketCount === 0 &&
                diagnostics.aboutHtmlLength === 0 &&
                !scrape.heroImage;
              if (verbose) {
                const redirectInfo =
                  payload.url !== `${baseUrl}/${eventSlug}` ? ` redirect=${payload.url}` : "";
                console.log(
                  `Scraped ${eventSlug} [${sourceLabel}]: lineupRows=${diagnostics.lineupRowCount} ` +
                    `tickets=${diagnostics.ticketCount} aboutHtml=${diagnostics.aboutHtmlLength} ` +
                    `hero=${scrape.heroImage ? "yes" : "no"}` +
                    redirectInfo
                );
              } else if (likelyEmpty) {
                console.warn(
                  `Empty page content for ${eventSlug} (htmlLength=${diagnostics.htmlLength}).`
                );
              } else if (diagnostics.lineupTableExists && diagnostics.lineupRowCount === 0) {
                console.warn(`Lineup table empty for ${eventSlug}.`);
              }
              yield* (upsertEventPageScrape(sql, scrape, { overwrite }));
              return "ok" as const;
            }).pipe(
              Effect.catch((error) => {
                failed += 1;
                const message =
                  error instanceof Error
                    ? error.message
                    : typeof error === "string"
                      ? error
                      : JSON.stringify(error);
                console.error(`Scrape failed for ${eventSlug}: ${message}`);
                return Effect.succeed("failed" as const);
              })
            )
          );

          processed += 1;
          if (processed % 25 === 0 || processed === sliced.length) {
            const elapsedMinutes = Math.max(1, (Date.now() - startTime) / 60000);
            const rate = Math.round(processed / elapsedMinutes);
            console.log(
              `[${processed}/${sliced.length}] failed=${failed} rate=${rate}/min last=${eventSlug} ${result}`
            );
          }
        }),
      { concurrency }
    )
  );

  console.log(`Scrape complete. processed=${processed} failed=${failed}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
// Provide the browser-render service so Cloudflare-blocked event pages fall back
// to a real browser. Merged, not required (read via serviceOption), so the script
// still runs plain-fetch-only if rendering is unavailable.
const AppLayer = Layer.merge(SqlLayer, BrowserbaseServiceLive);

Effect.runPromise(main.pipe(Effect.provide(AppLayer))).catch((error) => {
  console.error("Event page scrape failed:", error);
  process.exitCode = 1;
});
