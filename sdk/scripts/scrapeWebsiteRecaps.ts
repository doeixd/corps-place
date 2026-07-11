// Scrape DCI score recaps from the public website and ingest into SQLite.
// Usage: npx tsx scripts/scrapeWebsiteRecaps.ts --season=2023 [--maxPages=10] [--concurrency=3] [--retries=3] [--verify]

import { Duration, Effect, Layer, Schedule } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";

import { ensureRelationalSchema } from "../src/relational.js";
import { BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  scrapeWebsiteRecaps,
  verifyWebsiteRecaps
} from "../src/websiteScraper.js";
import { normalizeIngestedData } from "../src/normalizeDivisions.js";

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

const args = process.argv.slice(2);
const season = parseStringFlag(args, "--season") ?? "2023";
const maxPages = parseNumberFlag(args, "--maxPages");
const concurrency = parseNumberFlag(args, "--concurrency") ?? 3;
const retries = parseNumberFlag(args, "--retries") ?? 3;
const verify = args.includes("--verify");
// Optional: scrape recaps for ONLY these comma-separated slugs (the auto-ingest
// passes the pending show so it doesn't re-scrape the whole season each poll).
const onlySlugs = (parseStringFlag(args, "--slugs") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const verifySlugs = [
  "2023-dci-world-championship-finals",
  "2023-dci-southwestern-championship",
  "2023-dci-eastern-classic-2"
];

const main = Effect.gen(function* () {
  yield* (ensureRelationalSchema);
  const result = yield* (
    scrapeWebsiteRecaps({
      seasons: [season],
      maxPages,
      concurrency,
      ingest: true,
      ...(onlySlugs.length ? { onlySlugs } : {})
    })
  );

  console.log("\n=== Website Recap Scrape ===");
  console.log(`Season: ${season}`);
  console.log(`Score list pages: ${result.scoreLists}`);
  console.log(`Recaps scraped: ${result.recaps}`);
  console.log(`Corps scores ingested: ${result.corpsScores}`);

  // Keep the source clean: collapse any generic "All Age Class" rows onto the
  // corps's specific all-age class so DCA corps don't double in rankings.
  yield* normalizeIngestedData;
  console.log("Normalized all-age division labels + lineup aliases.");

  if (verify) {
    const checks = yield* (verifyWebsiteRecaps(verifySlugs));
    console.log("\n=== Verification (Top 3) ===");
    for (const check of checks) {
      console.log(`\n${check.slug}`);
      check.topScores.forEach((row) => {
        console.log(`#${row.rank} ${row.corpsName} - ${row.totalScore}`);
      });
    }
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

// Provide the browser-render service so recap fetches that hit Cloudflare's 403
// challenge (any newly-released event not yet cached) fall back to a real
// browser and actually land. Merged, not required: the scraper reads it via
// serviceOption, so the plain-fetch path still works if rendering is unavailable.
const AppLayer = Layer.merge(SqlLayer, BrowserbaseServiceLive);

Effect.runPromise(main.pipe(Effect.provide(AppLayer)))
  .then(() => {
    console.log("\nDone!");
  })
  .catch((err) => {
    console.error("Scrape failed:", err);
    process.exitCode = 1;
  });
