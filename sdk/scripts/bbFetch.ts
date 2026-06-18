// Browserbase-rendered fetch for JS-only pages (e.g. WGI judge profiles that
// WebFetch can't see because the content is client-rendered).
//
// Usage (from sdk/, with BROWSERBASE_API_KEY in the repo-root .env):
//   npx tsx scripts/bbFetch.ts <url> [<url> ...]
//
// Prints, per URL: candidate judge image srcs + the main paragraph text, so we
// can harvest a headshot + bio for judges whose pages don't render server-side.

import { readFileSync } from "node:fs";
import { Effect } from "effect";
import * as cheerio from "cheerio";
import { BrowserbaseService, BrowserbaseServiceLive } from "../src/browserbaseService.js";

// Load the repo-root .env (BROWSERBASE_API_KEY) without adding a dep.
for (const path of ["../.env", ".env"]) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const urls = process.argv.slice(2).filter((a) => a.startsWith("http"));

const main = Effect.gen(function* () {
  const bb = yield* (BrowserbaseService);
  for (const url of urls) {
    yield* (Effect.logInfo(`\n=== ${url} ===`));
    const html = yield* (bb.fetchHtml(url).pipe(Effect.catch((e) => Effect.logError(String(e)).pipe(Effect.as("")))));
    if (!html) continue;
    const $ = cheerio.load(html);
    const imgs = new Set<string>();
    $("img").each((_i, el) => {
      const src = $(el).attr("src") ?? $(el).attr("data-src");
      if (src && /uploads|judge|headshot|wp-content|s3|\.jpg|\.png|\.jpeg/i.test(src)) imgs.add(src);
    });
    yield* (Effect.logInfo(`images:\n${[...imgs].map((s) => "  " + s).join("\n") || "  (none)"}`));
    const text = $("article, .entry-content, main, .judge, body").first().text().replace(/\s+/g, " ").trim();
    yield* (Effect.logInfo(`text (first 1200 chars):\n${text.slice(0, 1200)}`));
  }
});

Effect.runPromise(main.pipe(Effect.provide(BrowserbaseServiceLive))).catch((e) => {
  console.error("bbFetch failed:", e);
  process.exitCode = 1;
});
