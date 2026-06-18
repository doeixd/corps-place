import { Context, Effect, Layer } from "effect";
import * as cheerio from "cheerio";
import { DciOrgCloudflareError } from "./showErrors.js";

/* ------------------------------------------------------------------ */
/*  DCI.org news scraper — minimal implementation                     */
/*  DCI.org is behind Cloudflare; direct fetch is blocked.           */
/*  This service detects the block and archives the attempt.          */
/* ------------------------------------------------------------------ */

const DCI_ORG_NEWS_URL = "https://www.dci.org/news";

const fetchDciOrgPage = Effect.fn("DciOrgScraper.fetchPage")(
  function* (url: string) {
    yield* Effect.log("Fetching DCI.org page", { url });

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

const isCloudflareBlock = (html: string): boolean => {
  const lower = html.toLowerCase();
  return (
    lower.includes("cloudflare") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("checking your browser") ||
    lower.includes("turnstile") ||
    lower.includes("just a moment")
  );
};

// Pure: parse DCI.org news HTML for show announcement articles
const parseDciOrgNews = (html: string): Array<{
  title: string;
  url: string;
  date: string | null;
}> => {
  const $ = cheerio.load(html);
  const articles: Array<{ title: string; url: string; date: string | null }> =
    [];

  $("article a, .news-item a, .post a, h2 a, h3 a").each((_i, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href") || "";
    if (title && href && title.length > 5 && title.length < 120) {
      const fullUrl = href.startsWith("http")
        ? href
        : `https://www.dci.org${href}`;
      articles.push({ title, url: fullUrl, date: null });
    }
  });

  return articles;
};

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

const makeDciOrgScraper = Effect.gen(function* () {
      const scrapeNews = Effect.fn("DciOrgScraper.scrapeNews")(
        function* () {
          yield* Effect.log("Scraping DCI.org news");

          const html = yield* fetchDciOrgPage(DCI_ORG_NEWS_URL).pipe(
            Effect.catchTag("DciOrgCloudflareError", (err) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("DCI.org blocked by Cloudflare", {
                  url: err.url,
                  message: err.message,
                });
                return null as string | null;
              })
            )
          );

          if (!html) {
            return [] as Array<{
              title: string;
              url: string;
              date: string | null;
            }>;
          }

          if (isCloudflareBlock(html)) {
            yield* Effect.logWarning(
              "DCI.org returned Cloudflare challenge page"
            );
            return [] as Array<{
              title: string;
              url: string;
              date: string | null;
            }>;
          }

          const articles = parseDciOrgNews(html);

          yield* Effect.log("DCI.org news parse complete", {
            articleCount: articles.length,
          });

          return articles;
        }
      );

      return { scrapeNews };
});

export class DciOrgScraper extends Context.Service<
  DciOrgScraper,
  Effect.Success<typeof makeDciOrgScraper>
>()("DciOrgScraper") {}

export const DciOrgScraperLive = Layer.effect(DciOrgScraper, makeDciOrgScraper);
