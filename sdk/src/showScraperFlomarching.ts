import { Context, Effect, Layer } from "effect";
import * as cheerio from "cheerio";
import {
  DciOrgCloudflareError,
  FloMarchingPaywallError,
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
/*  FloMarching scraper — minimal implementation with paywall handling */
/* ------------------------------------------------------------------ */

interface FloMarchingScrapedShow {
  readonly corpsKey: string;
  readonly corpsName: string;
  readonly season: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly subtitle: string | null;
  readonly sourceUrl: string;
  readonly repertoire: ShowRepertoireEntry[];
  readonly designers: ShowDesigner[];
  readonly movements: ShowMovement[];
  readonly media: ShowMediaAsset[];
}

const FLOMARCHING_BASE = "https://www.flomarching.com";

// Attempt to fetch a FloMarching article URL
const fetchFloMarchingArticle = Effect.fn("FloMarchingScraper.fetchArticle")(
  function* (url: string) {
    yield* Effect.log("Fetching FloMarching article", { url });

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,*/*;q=0.8",
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
  }
);

// Detect paywall or Cloudflare block
const isPaywalledOrBlocked = (html: string): boolean => {
  const lower = html.toLowerCase();
  return (
    lower.includes("subscribe") ||
    lower.includes("membership") ||
    lower.includes("premium content") ||
    lower.includes("sign in") ||
    lower.includes("login to read") ||
    lower.includes("cloudflare") ||
    lower.includes("cf-browser-verification") ||
    html.length < 2000 // Very short response = likely blocked
  );
};

// Pure: parse FloMarching article HTML
const parseFloMarchingArticle = (
  html: string,
  url: string,
  corpsKey: string,
  corpsName: string,
  season: number
): FloMarchingScrapedShow | null => {
  const $ = cheerio.load(html);

  // Check for paywall indicators
  if (isPaywalledOrBlocked(html)) {
    return null;
  }

  // Extract title from article
  const articleTitle = $("h1").first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const title = articleTitle || ogTitle || null;

  // Extract description from article body
  const articleBody = $("article, .article-body, .content, .post-content").first().text();
  const metaDesc = $('meta[name="description"]').attr("content");
  const description = (articleBody || metaDesc || "").slice(0, 800) || null;

  // Extract designers (heuristic patterns)
  const designers: ShowDesigner[] = [];
  const text = $("body").text();
  const designerPatterns = [
    /(?:show\s+designer|program\s+coordinator|brass\s+arranger|visual\s+designer|percussion\s+arranger|drum\s+writer)[\s:]*([^\n]{2,50})/gi,
    /(?:arranged\s+by|written\s+by|designed\s+by)[\s:]*([^\n]{2,50})/gi,
  ];
  for (const pattern of designerPatterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const name = m[1].trim().replace(/[^a-zA-Z\s\.\-']/g, "").trim();
      if (name.length > 2 && name.length < 50) {
        const roleMatch = m[0].toLowerCase().match(
          /show\s+designer|program\s+coordinator|brass\s+arranger|visual\s+designer|percussion\s+arranger|drum\s+writer|arranged\s+by|written\s+by|designed\s+by/
        );
        const role = roleMatch
          ? roleMatch[0]
              .replace(/by\s*$/, "")
              .replace(/\s+$/, "")
              .trim()
          : "Designer";
        designers.push({
          designerId: `${corpsKey}_${season}_flom_designer_${designers.length}`,
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

  // Extract images
  const media: ShowMediaAsset[] = [];
  $("article img, .article-body img, .content img").each((_i, el) => {
    const src = $(el).attr("src");
    if (src && src.startsWith("http")) {
      media.push({
        mediaId: `${corpsKey}_${season}_flom_media_${media.length}`,
        showId: makeShowId(corpsKey, season),
        mediaType: "image",
        title: `${corpsName} FloMarching Photo`,
        description: null,
        url: src,
        thumbnailUrl: null,
        attribution: "FloMarching",
        publishedAt: null,
        durationSeconds: null,
      });
    }
  });

  // Extract repertoire from article text
  const repertoire: ShowRepertoireEntry[] = [];
  $("li, p").each((_i, el) => {
    const text = $(el).text();
    const songMatch = text.match(
      /^\s*["']?([^"'\n]{3,60})["']?\s*(?:by|arranged by|written by|composed by)/i
    );
    if (songMatch && songMatch[1]) {
      const workTitle = songMatch[1].trim();
      const composerMatch = text.match(/(?:by|composed by|written by|arranged by)\s+([^\n]{2,40})/i);
      const composer = composerMatch ? composerMatch[1].trim().slice(0, 60) : null;
      repertoire.push({
        entryId: `${makeShowId(corpsKey, season)}_flom_song_${repertoire.length}`,
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

  return {
    corpsKey,
    corpsName,
    season,
    title,
    description,
    subtitle: null,
    sourceUrl: url,
    repertoire,
    designers,
    movements: [],
    media,
  };
};

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

const makeFloMarchingScraper = Effect.gen(function* () {
      const scrapeArticle = Effect.fn("FloMarchingScraper.scrapeArticle")(
        function* (
          url: string,
          corpsKey: string,
          corpsName: string,
          season: number
        ) {
          yield* Effect.log("Scraping FloMarching article", {
            corpsKey,
            url,
          });

          const html = yield* fetchFloMarchingArticle(url);

          if (isPaywalledOrBlocked(html)) {
            return yield* Effect.fail(
              new FloMarchingPaywallError({
                url,
                message: "Article is paywalled or blocked",
              })
            );
          }

          const parsed = parseFloMarchingArticle(
            html,
            url,
            corpsKey,
            corpsName,
            season
          );

          if (!parsed) {
            return yield* Effect.fail(
              new FloMarchingPaywallError({
                url,
                message: "Could not parse article content",
              })
            );
          }

          yield* Effect.log("FloMarching parse complete", {
            corpsKey,
            title: parsed.title,
            designerCount: parsed.designers.length,
            mediaCount: parsed.media.length,
          });

          return parsed;
        }
      );

      const searchForCorps = Effect.fn("FloMarchingScraper.searchForCorps")(
        function* (corpsName: string, season: number) {
          yield* Effect.log("Searching FloMarching for corps", {
            corpsName,
            season,
          });

          // Build search URL (FloMarching search page)
          const searchUrl = `${FLOMARCHING_BASE}/search?q=${encodeURIComponent(
            `${corpsName} ${season}`
          )}`;

          const html = yield* fetchFloMarchingArticle(searchUrl).pipe(
            Effect.catchTag("DciOrgCloudflareError", () =>
              Effect.succeed(null as string | null)
            )
          );

          if (!html) {
            return null;
          }

          const $ = cheerio.load(html);
          const firstArticleLink = $("article a, .search-result a, .article-card a")
            .first()
            .attr("href");

          if (!firstArticleLink) {
            return null;
          }

          const fullUrl = firstArticleLink.startsWith("http")
            ? firstArticleLink
            : `${FLOMARCHING_BASE}${firstArticleLink}`;

          return fullUrl;
        }
      );

      return { scrapeArticle, searchForCorps };
});

export class FloMarchingScraper extends Context.Service<
  FloMarchingScraper,
  Effect.Success<typeof makeFloMarchingScraper>
>()("FloMarchingScraper") {}

export const FloMarchingScraperLive = Layer.effect(
  FloMarchingScraper,
  makeFloMarchingScraper
);

/* ------------------------------------------------------------------ */
/*  Export pure helper: convert FloMarchingScrapedShow → CorpsShow    */
/* ------------------------------------------------------------------ */

export const buildShowFromFloMarching = (
  scraped: FloMarchingScrapedShow
): Partial<CorpsShow> => ({
  showId: makeShowId(scraped.corpsKey, scraped.season),
  corpsKey: scraped.corpsKey,
  corpsName: scraped.corpsName,
  season: String(scraped.season),
  title: scraped.title ?? undefined,
  subtitle: scraped.subtitle,
  description: scraped.description,
  sourceUrl: scraped.sourceUrl,
  tags: [],
  repertoire: scraped.repertoire,
  media: scraped.media,
  designers: scraped.designers,
  movements: scraped.movements,
  reviews: [],
  metadata: {
    sourceType: "flomarching",
    parsedAt: new Date().toISOString(),
  },
});
