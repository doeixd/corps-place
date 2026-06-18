import { load } from "cheerio";
import { Effect } from "effect";

import { parseRecapHtml, recapUrl } from "../src/websiteRecap.js";

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

const cleanText = (value: string | undefined | null) =>
  (value ?? "").replace(/\s\s+/g, " ").trim();

const args = process.argv.slice(2);
const season = parseStringFlag(args, "--season") ?? "2025";
const page = parseNumberFlag(args, "--page") ?? 1;

const fetchScorePageConfig = async (seasonValue: string) => {
  const pageUrl = `https://www.dci.org/scores/?location=&season=${seasonValue}&pageno=1`;
  const response = await fetch(pageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch scores page: ${response.status}`);
  }
  const html = await response.text();
  const ajaxMatch = html.match(
    /scoreEventAjax\s*=\s*\{[^}]*"ajax_url":"([^"]+)","nonce":"([^"]+)"/
  );
  const wrapperMatch = html.match(
    /id="score-pagination-wrapper"[^>]*data-post-type="([^"]+)"[^>]*data-posts-per-page="([^"]+)"/
  );

  if (!ajaxMatch || !wrapperMatch) {
    throw new Error("Failed to locate scoreEventAjax config on scores page");
  }

  const [, ajaxUrl, nonce] = ajaxMatch;
  const [, postType, postsPerPage] = wrapperMatch;

  return { pageUrl, ajaxUrl, nonce, postType, postsPerPage };
};

const fetchScoreEventsPage = async (seasonValue: string, pageValue: number) => {
  const config = await fetchScorePageConfig(seasonValue);
  const params = new URLSearchParams({
    action: "score_events",
    nonce: config.nonce,
    post_type: config.postType,
    posts_per_page: config.postsPerPage,
    paged: String(pageValue),
    filter_season: seasonValue,
    filter_location: ""
  });

  const response = await fetch(config.ajaxUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`Score events request failed: ${response.status}`);
  }

  const json = (await response.json()) as {
    success: boolean;
    data?: { content: string; current_page: number; total_pages: number };
  };

  if (!json.success || !json.data) {
    throw new Error("Score events response was not successful");
  }

  return {
    config,
    content: json.data.content,
    currentPage: json.data.current_page,
    totalPages: json.data.total_pages
  };
};

const main = async () => {
  const result = await fetchScoreEventsPage(season, page);
  const $ = load(result.content ?? "");
  const rows = $(".tbl-row").not(".poweredby-row");
  const firstRow = rows.first();
  const columns = firstRow.find(".row > div").length
    ? firstRow.find(".row > div")
    : firstRow.find("> div");

  const sample = {
    title: cleanText(columns.eq(0).text()),
    date: cleanText(columns.eq(1).text()),
    location: cleanText(columns.eq(2).text())
  };

  const recapLinks = rows
    .map((_, el) => {
      const link = $(el).find("a").attr("href") ?? "";
      if (!link) return undefined;
      return link.startsWith("http") ? link : `https://www.dci.org${link}`;
    })
    .get()
    .filter((link): link is string => Boolean(link));

  const toRecapSlug = (link: string) => {
    const url = new URL(link);
    const parts = url.pathname.split("/").filter(Boolean);
    const finalIndex = parts.indexOf("final-scores");
    return finalIndex >= 0 ? parts[finalIndex + 1] : parts[parts.length - 1];
  };

  const fetchRecapTopScores = async (sourceUrl: string) => {
    const slug = toRecapSlug(sourceUrl);
    const recapPageUrl = recapUrl(slug);
    const response = await fetch(recapPageUrl);
    if (!response.ok) {
      return { recapPageUrl, error: `HTTP ${response.status}` };
    }
    const recapHtml = await response.text();
    const recap = await Effect.runPromise(parseRecapHtml(recapHtml));
    const topScores = [...recap.corps]
      .sort((a, b) => (a.finalRank || 999) - (b.finalRank || 999))
      .slice(0, 3)
      .map((corp) => ({
        rank: corp.finalRank,
        corps: corp.corpsName,
        score: corp.finalScore
      }));

    return { recapPageUrl, title: recap.meta.title, topScores };
  };

  console.log("=== score_events probe ===");
  console.log(`Season: ${season}`);
  console.log(`Page: ${page}`);
  console.log(`Scores page URL: ${result.config.pageUrl}`);
  console.log(`AJAX URL: ${result.config.ajaxUrl}`);
  console.log(`Posts per page: ${result.config.postsPerPage}`);
  console.log(`Current page: ${result.currentPage}`);
  console.log(`Total pages: ${result.totalPages}`);
  console.log(`Rows returned: ${rows.length}`);
  console.log("First row sample:", JSON.stringify(sample, null, 2));
  console.log(`Recap links (${recapLinks.length}):`);
  recapLinks.forEach((link) => console.log(`- ${link}`));

  for (const recapLink of recapLinks) {
    const recapResult = await fetchRecapTopScores(recapLink);
    if ("error" in recapResult) {
      console.log(`Recap fetch failed: ${recapResult.recapPageUrl} (${recapResult.error})`);
      continue;
    }
    console.log(`\nRecap: ${recapResult.recapPageUrl}`);
    console.log(`Title: ${recapResult.title || "(unknown)"}`);
    recapResult.topScores.forEach((row) => {
      console.log(`- #${row.rank} ${row.corps} ${row.score}`);
    });
  }
};

main().catch((error) => {
  console.error("Probe failed:", error);
  process.exitCode = 1;
});
