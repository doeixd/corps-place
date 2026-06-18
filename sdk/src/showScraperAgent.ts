import { Context, Effect, Layer } from "effect";
import { execSync } from "node:child_process";
import * as cheerio from "cheerio";
import {
  AgentExplorationError,
  DciOrgCloudflareError,
} from "./showErrors.js";
import type {
  CorpsShow,
  ShowDesigner,
  ShowMediaAsset,
  ShowMovement,
  ShowRepertoireEntry,
} from "./extraDomain.js";
import { makeShowId } from "./showOrchestrator.js";

/* ------------------------------------------------------------------ */
/*  Confidence scoring                                                 */
/* ------------------------------------------------------------------ */

type Confidence = "HIGH" | "MEDIUM" | "LOW";

interface AgentScrapedShow {
  readonly corpsKey: string;
  readonly corpsName: string;
  readonly season: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly subtitle: string | null;
  readonly tagline: string | null;
  readonly sourceUrl: string;
  readonly sourceType: string;
  readonly repertoire: ShowRepertoireEntry[];
  readonly designers: ShowDesigner[];
  readonly movements: ShowMovement[];
  readonly media: ShowMediaAsset[];
  readonly confidence: Confidence;
}

/* ------------------------------------------------------------------ */
/*  Tier 1: Direct fetch + cheerio parsing                            */
/* ------------------------------------------------------------------ */

interface KnownCorpsUrls {
  website: string | null;
  facebook: string | null;
  instagram: string | null;
  twitter: string | null;
}

const fetchHtml = Effect.fn("AgentScraper.fetchHtml")(
  function* (url: string, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
          }),
        catch: (e) =>
          new DciOrgCloudflareError({
            url,
            message: `Fetch failed: ${String(e)}`,
          }),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          new DciOrgCloudflareError({
            url,
            message: `HTTP ${response.status}`,
          })
        );
      }
      const html = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) =>
          new DciOrgCloudflareError({
            url,
            message: `Read body failed: ${String(e)}`,
          }),
      });
      return html;
    } finally {
      clearTimeout(timer);
    }
  }
);

const isCloudflareBlock = (html: string): boolean => {
  const lower = html.toLowerCase();
  return (
    lower.includes("cloudflare") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("turnstile") ||
    lower.includes("checking your browser")
  );
};

// Common URL patterns for 2026 show announcement pages
const GUESS_PATHS = [
  "/2026-show",
  "/2026",
  "/show",
  "/announcements",
  "/news",
  "/season-2026",
  "/2026-season",
  "/program",
  "/production",
];

// Pure: try to construct announcement URLs from a base website URL
const guessAnnouncementUrls = (baseUrl: string): string[] => {
  const normalized = baseUrl.replace(/\/+$/, "");
  return GUESS_PATHS.map((p) => `${normalized}${p}`);
};

// Pure: extract show data from HTML using heuristics
const extractShowFromHtml = (
  html: string,
  url: string,
  corpsKey: string,
  corpsName: string,
  season: number
): AgentScrapedShow | null => {
  const $ = cheerio.load(html);
  const text = $("body").text();
  const lowerText = text.toLowerCase();

  // Heuristic 1: Look for "2026" + "show" + title patterns in page text
  const showTitlePatterns = [
    /(?:announcing|presenting|introducing)[\s:]+["']?([^"'\n]{3,60})["']?/i,
    /(?:2026\s+show\s+(?:is|titled)?\s*[:\-]?\s*["']?)([^"'\n]{3,60})/i,
    /(?:show\s+(?:title|name)\s*[:\-]?\s*["']?)([^"'\n]{3,60})/i,
    /(?:production\s+[:\-]?\s*["']?)([^"'\n]{3,60})/i,
    /(?:program\s+[:\-]?\s*["']?)([^"'\n]{3,60})/i,
  ];

  let title: string | null = null;
  for (const pattern of showTitlePatterns) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Filter out generic phrases
      if (
        candidate.length > 3 &&
        !candidate.toLowerCase().includes("drum corps") &&
        !candidate.toLowerCase().includes("announcement") &&
        !candidate.toLowerCase().includes("2026")
      ) {
        title = candidate;
        break;
      }
    }
  }

  // Heuristic 2: Look for meta/title if no pattern match
  if (!title) {
    const ogTitle = $('meta[property="og:title"]').attr("content");
    const pageTitle = $("title").text().trim();
    // Use og:title or title if it contains the corps name and seems like a show title
    const candidate = ogTitle || pageTitle;
    if (
      candidate &&
      candidate.toLowerCase().includes(corpsName.toLowerCase().split(" ")[0]) &&
      candidate.length > 5 &&
      candidate.length < 80
    ) {
      title = candidate;
    }
  }

  // Heuristic 3: Look for description/meta description
  let description: string | null = null;
  const metaDesc = $('meta[name="description"]').attr("content");
  const ogDesc = $('meta[property="og:description"]').attr("content");
  description = (ogDesc || metaDesc || null)?.slice(0, 500) ?? null;

  // Heuristic 4: Look for designer credits
  const designers: ShowDesigner[] = [];
  const designerPatterns = [
    /(?:show\s+designer|program\s+coordinator|visual\s+designer|music\s+arranger|drum\s+writer)[\s:]*([^\n]{2,40})/gi,
    /(?:arranged\s+by|written\s+by|designed\s+by)[\s:]*([^\n]{2,40})/gi,
  ];
  for (const pattern of designerPatterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const name = m[1].trim().replace(/[^a-zA-Z\s\.\-']/g, "").trim();
      if (name.length > 2 && name.length < 50) {
        const roleMatch = m[0].toLowerCase().match(
          /show\s+designer|program\s+coordinator|visual\s+designer|music\s+arranger|drum\s+writer|arranged\s+by|written\s+by|designed\s+by/
        );
        const role = roleMatch
          ? roleMatch[0]
              .replace(/by\s*$/, "")
              .replace(/\s+$/, "")
              .trim()
          : "Designer";
        designers.push({
          designerId: `${corpsKey}_${season}_designer_${designers.length}`,
          showId: makeShowId(corpsKey, season),
          corpsKey,
          role: role.charAt(0).toUpperCase() + role.slice(1),
          name,
          sourceUrl: url,
          scrapedAt: Date.now(),
        });
      }
    }
  }

  // Heuristic 5: Look for movement/program titles
  const movements: ShowMovement[] = [];
  const movementPatterns = [
    /(?:movement\s+(?:i|ii|iii|iv|v|vi|1|2|3|4|5|6)\s*[:\-]?\s*["']?)([^"'\n]{3,60})/gi,
    /(?:act\s+(?:i|ii|iii|1|2|3)\s*[:\-]?\s*["']?)([^"'\n]{3,60})/gi,
  ];
  for (const pattern of movementPatterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const name = m[1].trim();
      if (name.length > 3) {
        movements.push({
          movementId: `${corpsKey}_${season}_movement_${movements.length}`,
          showId: makeShowId(corpsKey, season),
          corpsKey,
          ordinal: movements.length + 1,
          title: name,
          description: null,
          sourceUrl: url,
          scrapedAt: Date.now(),
        });
      }
    }
  }

  // Heuristic 6: Look for repertoire (song names in lists or text)
  const repertoire: ShowRepertoireEntry[] = [];
  $("li, p").each((_i, el) => {
    const text = $(el).text();
    const songMatch = text.match(
      /^\s*["']?([^"'\n]{3,60})["']?\s*(?:by|arranged by|written by|composed by)/i
    );
    if (songMatch && songMatch[1]) {
      const workTitle = songMatch[1].trim();
      // Try to extract composer
      const composerMatch = text.match(/(?:by|composed by|written by|arranged by)\s+([^\n]{2,40})/i);
      const composer = composerMatch ? composerMatch[1].trim().slice(0, 60) : null;
      repertoire.push({
        entryId: `${makeShowId(corpsKey, season)}_song_${repertoire.length}`,
        showId: makeShowId(corpsKey, season),
        workTitle,
        composer,
        arranger: null,
        description: null,
        hyperlink: null,
        relatedCorpsKey: null,
        notes: null,
      });
    }
  });

  // Heuristic 7: Look for embedded videos / images
  const media: ShowMediaAsset[] = [];
  $("iframe[src*='youtube'], iframe[src*='vimeo']").each((_i, el) => {
    const src = $(el).attr("src");
    if (src) {
      media.push({
        mediaId: `${corpsKey}_${season}_media_${media.length}`,
        showId: makeShowId(corpsKey, season),
        mediaType: "video",
        title: `${corpsName} 2026 Show Video`,
        description: null,
        url: src,
        thumbnailUrl: null,
        attribution: null,
        publishedAt: null,
        durationSeconds: null,
      });
    }
  });

  // Determine confidence
  let confidence: Confidence = "LOW";
  if (title && designers.length > 0 && (repertoire.length > 0 || description)) {
    confidence = "HIGH";
  } else if (title && (designers.length > 0 || description)) {
    confidence = "MEDIUM";
  } else if (title) {
    confidence = "MEDIUM";
  }

  return {
    corpsKey,
    corpsName,
    season,
    title,
    description,
    subtitle: null,
    tagline: null,
    sourceUrl: url,
    sourceType: "corps_website",
    repertoire,
    designers,
    movements,
    media,
    confidence,
  };
};

/* ------------------------------------------------------------------ */
/*  Tier 2: Browser-tools CLI wrapper (Edge CDP)                       */
/* ------------------------------------------------------------------ */

const runBrowserToolsSearch = (
  query: string,
  count = 3
): Effect.Effect<
  Array<{ title: string; link: string; snippet: string }>,
  AgentExplorationError
> =>
  Effect.gen(function* () {
    yield* Effect.log("Running browser-tools search", { query });

    const result = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const { exec } = require("node:child_process");
          exec(
            `npx tsx scripts/browser-tools.ts search "${query.replace(/"/g, '\\"')}" -n ${count}`,
            { cwd: "C:\\Users\\Patrick\\corps-place", timeout: 30000, shell: true },
            (err: Error | null, stdout: string, stderr: string) => {
              if (err) reject(err);
              else resolve(stdout);
            }
          );
        }),
      catch: (e) =>
        new AgentExplorationError({
          corpsKey: "",
          message: `browser-tools search failed: ${String(e)}`,
          urlsChecked: [],
        }),
    });

    // Parse the text output
    const urls: Array<{ title: string; link: string; snippet: string }> = [];
    const lines = result.split("\n");
    let current: Partial<{ title: string; link: string; snippet: string }> = {};
    for (const line of lines) {
      if (line.startsWith("Title: ")) {
        if (current.title) urls.push(current as any);
        current = { title: line.slice(7).trim() };
      } else if (line.startsWith("Link: ")) {
        current.link = line.slice(6).trim();
      } else if (line.startsWith("Snippet: ")) {
        current.snippet = line.slice(9).trim();
      }
    }
    if (current.title) urls.push(current as any);

    return urls;
  });

const runBrowserToolsContent = (
  url: string
): Effect.Effect<{ title?: string; content?: string; url: string }, AgentExplorationError> =>
  Effect.gen(function* () {
    yield* Effect.log("Running browser-tools content extraction", { url });

    const result = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          const { exec } = require("node:child_process");
          exec(
            `npx tsx scripts/browser-tools.ts content "${url.replace(/"/g, '\\"')}"`,
            { cwd: "C:\\Users\\Patrick\\corps-place", timeout: 20000, shell: true },
            (err: Error | null, stdout: string, stderr: string) => {
              if (err) reject(err);
              else resolve(stdout);
            }
          );
        }),
      catch: (e) =>
        new AgentExplorationError({
          corpsKey: "",
          message: `browser-tools content failed: ${String(e)}`,
          urlsChecked: [url],
        }),
    });

    const lines = result.split("\n");
    const titleLine = lines.find((l) => l.startsWith("Title: "));
    const urlLine = lines.find((l) => l.startsWith("URL: "));
    const contentStart = lines.findIndex((l) => l.trim() === "");
    const content =
      contentStart >= 0 ? lines.slice(contentStart + 1).join("\n").trim() : "";

    return {
      title: titleLine?.slice(7).trim(),
      content,
      url: urlLine?.slice(5).trim() || url,
    };
  });

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

const makeShowScraperAgent = Effect.gen(function* () {
      /* ---------------------------------------------------------------- */
      /*  Discover announcement pages for a corps                         */
      /* ---------------------------------------------------------------- */
      const discoverPages = Effect.fn("ShowScraperAgent.discoverPages")(
        function* (corpsKey: string, corpsName: string, urls: KnownCorpsUrls) {
          const discovered: string[] = [];

          if (urls.website) {
            const guesses = guessAnnouncementUrls(urls.website);
            for (const url of guesses) {
              const html = yield* fetchHtml(url).pipe(
                Effect.catchTag("DciOrgCloudflareError", () => Effect.succeed(null))
              );
              if (html && !isCloudflareBlock(html)) {
                const text = cheerio.load(html)("body").text().toLowerCase();
                if (
                  text.includes("2026") &&
                  (text.includes("show") ||
                    text.includes("program") ||
                    text.includes("production") ||
                    text.includes("announce"))
                ) {
                  discovered.push(url);
                }
              }
            }
          }

          return discovered;
        }
      );

      /* ---------------------------------------------------------------- */
      /*  Scrape a single corps via multiple strategies                    */
      /* ---------------------------------------------------------------- */
      const scrapeCorps = Effect.fn("ShowScraperAgent.scrapeCorps")(
        function* (
          corpsKey: string,
          corpsName: string,
          season: number,
          urls: KnownCorpsUrls
        ) {
          yield* Effect.log("Agent scraping corps", { corpsKey, corpsName });

          const checkedUrls: string[] = [];
          let bestResult: AgentScrapedShow | null = null;

          // Strategy 1: Direct fetch from known website paths
          const discovered = yield* discoverPages(
            corpsKey,
            corpsName,
            urls
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])));

          for (const url of discovered) {
            checkedUrls.push(url);
            const html = yield* fetchHtml(url).pipe(
              Effect.catchTag("DciOrgCloudflareError", () => Effect.succeed(null))
            );
            if (html && !isCloudflareBlock(html)) {
              const parsed = extractShowFromHtml(
                html,
                url,
                corpsKey,
                corpsName,
                season
              );
              if (parsed && (!bestResult || parsed.confidence > bestResult.confidence)) {
                bestResult = parsed;
              }
            }
          }

          // Strategy 2: If no good result, try browser-tools search
          if (!bestResult || bestResult.confidence === "LOW") {
            const searchQuery = `${corpsName} drum corps 2026 show announcement title`;
            const searchResults = yield* runBrowserToolsSearch(searchQuery, 3).pipe(
              Effect.catchTag("AgentExplorationError", () => Effect.succeed([] as any[]))
            );

            for (const result of searchResults.slice(0, 2)) {
              if (!result.link) continue;
              checkedUrls.push(result.link);

              const article = yield* runBrowserToolsContent(result.link).pipe(
                Effect.catchTag("AgentExplorationError", () =>
                  Effect.succeed({ content: "", url: result.link } as any)
                )
              );

              if (article.content) {
                const parsed = extractShowFromHtml(
                  `<body>${article.content}</body>`,
                  result.link,
                  corpsKey,
                  corpsName,
                  season
                );
                if (parsed && (!bestResult || parsed.confidence > bestResult.confidence)) {
                  bestResult = parsed;
                }
              }
            }
          }

          if (!bestResult || bestResult.confidence === "LOW") {
            return yield* Effect.fail(
              new AgentExplorationError({
                corpsKey,
                message: `No reliable show data found for ${corpsName} in ${season}`,
                urlsChecked: checkedUrls,
              })
            );
          }

          return bestResult;
        }
      );

      /* ---------------------------------------------------------------- */
      /*  Scrape multiple corps (batch)                                    */
      /* ---------------------------------------------------------------- */
      const scrapeCorpsBatch = Effect.fn("ShowScraperAgent.scrapeCorpsBatch")(
        function* (
          targets: Array<{
            corpsKey: string;
            corpsName: string;
            season: number;
            urls: KnownCorpsUrls;
          }>
        ) {
          yield* Effect.log("Starting agent batch scrape", { count: targets.length });

          const results: AgentScrapedShow[] = [];
          const errors: AgentExplorationError[] = [];

          // Sequential to avoid overwhelming sites
          for (const target of targets) {
            const result = yield* scrapeCorps(
              target.corpsKey,
              target.corpsName,
              target.season,
              target.urls
            ).pipe(
              Effect.match({
                onSuccess: (show) => {
                  results.push(show);
                  return null;
                },
                onFailure: (err) => {
                  if (err instanceof AgentExplorationError) {
                    errors.push(err);
                  }
                  return null;
                },
              })
            );
            // Small delay between requests
            yield* Effect.sleep("500 millis");
          }

          yield* Effect.log("Agent batch complete", {
            found: results.length,
            failed: errors.length,
          });

          return { results, errors };
        }
      );

      return { scrapeCorps, scrapeCorpsBatch };
});

export class ShowScraperAgent extends Context.Service<
  ShowScraperAgent,
  Effect.Success<typeof makeShowScraperAgent>
>()("ShowScraperAgent") {}

export const ShowScraperAgentLive = Layer.effect(ShowScraperAgent, makeShowScraperAgent);

/* ------------------------------------------------------------------ */
/*  Export pure helper: convert AgentScrapedShow → CorpsShow            */
/* ------------------------------------------------------------------ */

export const buildShowFromAgent = (
  scraped: AgentScrapedShow
): CorpsShow => ({
  showId: makeShowId(scraped.corpsKey, scraped.season),
  corpsKey: scraped.corpsKey,
  corpsName: scraped.corpsName,
  season: String(scraped.season),
  title: scraped.title ?? "(No title yet)",
  subtitle: scraped.subtitle,
  description: scraped.description,
  premiereDate: null,
  venue: null,
  tagline: scraped.tagline,
  designerNotes: null,
  sourceUrl: scraped.sourceUrl,
  tags: [],
  repertoire: scraped.repertoire,
  media: scraped.media,
  designers: scraped.designers,
  movements: scraped.movements,
  reviews: [],
  metadata: {
    confidence: scraped.confidence,
    sourceType: scraped.sourceType,
    parsedAt: new Date().toISOString(),
  },
});
