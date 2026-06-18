#!/usr/bin/env node
// Show announcement research & ingestion pipeline.
//
// Usage:
//   npx tsx scripts/ingestShowAnnouncements.ts              # dry-run DCX scraper (default)
//   npx tsx scripts/ingestShowAnnouncements.ts --apply      # write to DB
//   npx tsx scripts/ingestShowAnnouncements.ts --source dcx --apply
//   npx tsx scripts/ingestShowAnnouncements.ts --season 2026 --apply
//
// Four sources are supported (in order of priority):
//   1. dcx          — DCX Museum (free, structured, no login)
//   2. flomarching  — FloMarching articles (Browserbase, may be paywalled)
//   3. dciorg       — DCI.org news (Browserbase, Cloudflare)
//   4. agent        — Browser agent exploring corps sites + social media

import * as fs from "node:fs";
import * as path from "node:path";

// Load .env from repo root (scripts run from sdk/)
const envPath = path.resolve(process.cwd(), "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { ensureRelationalSchema } from "../src/relational.js";
import { ShowOrchestrator } from "../src/showOrchestrator.js";
import { makeShowLayers } from "../src/showLayers.js";

// CLI args
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const apply = has("--apply");
const report = has("--report");
const seasonArg = getArg("--season") ?? "2026";
const season = Number(seasonArg.split("-")[0]);
const source = getArg("--source") ?? "dcx";
const dbPath = getArg("--db") ?? "file:./dci-relational.db";

// Parse a --season range ("2013-2025") or single year into a list of seasons.
const parseSeasons = (raw: string): number[] => {
  const m = /^(\d{4})-(\d{4})$/.exec(raw.trim());
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    const out: number[] = [];
    for (let y = Math.min(lo, hi); y <= Math.max(lo, hi); y++) out.push(y);
    return out;
  }
  return [Number(raw)];
};

console.log(`Season: ${season}`);
console.log(`Source: ${source}`);
console.log(`DB: ${dbPath}`);
console.log();

// dcx-history honors dry-run *inside* the program (it fetches + reports without
// writing), so don't short-circuit here.
if (!apply && source !== "dcx-history") {
  console.log("=== DRY-RUN MODE ===");
  console.log("No DB writes will be performed. This mode reports what WOULD happen.");
  console.log("Pass --apply to persist to DB.");
  console.log();
  console.log("Would run the following sources:");
  const sources = source === "all" ? ["dcx", "flomarching", "agent", "dciorg"] : [source];
  for (const s of sources) {
    console.log(`  - ${s}`);
  }
  console.log();
  console.log("Dry-run complete. No changes made.");
  process.exit(0);
}

// Build the program
const program = Effect.gen(function* () {
  // Ensure schema exists (safe, idempotent)
  yield* ensureRelationalSchema;

  const orchestrator = yield* ShowOrchestrator;

  const results: unknown[] = [];

  if (source === "dcx" || source === "all") {
    console.log("Running DCX Museum scraper...");
    const dcxResults = yield* orchestrator.runDcxIngestion(season);

    console.log();
    console.log(`=== DCX Results (${dcxResults.length} corps) ===`);
    const successful = dcxResults.filter((r) => r.showId !== null);
    const failed = dcxResults.filter((r) => r.showId === null);

    console.log(`  Successful: ${successful.length}`);
    console.log(`  Failed: ${failed.length}`);

    if (failed.length > 0) {
      console.log();
      console.log("Failed entries:");
      for (const f of failed) {
        console.log(`  - ${f.corpsName}: ${f.error}`);
      }
    }

    if (successful.length > 0) {
      console.log();
      console.log("Top entries by song count:");
      const top = [...successful]
        .sort((a, b) => b.songCount - a.songCount)
        .slice(0, 10);
      for (const s of top) {
        console.log(`  - ${s.corpsName}: "${s.title}" (${s.songCount} songs)`);
      }
    }

    results.push(...dcxResults);
  }

  if (source === "dcx-history") {
    const seasons = parseSeasons(seasonArg);
    console.log(
      `Running DCX historical backfill for seasons ${seasons[0]}–${seasons[seasons.length - 1]} (${apply ? "APPLY" : "DRY-RUN"})...`
    );
    const { summary, found } = yield* orchestrator.runDcxHistoryIngestion({
      seasons,
      dryRun: !apply,
      refresh: has("--refresh"),
    });

    console.log();
    console.log("=== DCX History Results ===");
    console.log(`  Mapped corps:      ${summary.mappedCorps}`);
    console.log(`  Fetched:           ${summary.fetched}`);
    console.log(`  Available (real):  ${summary.available}`);
    console.log(`  Unavailable:       ${summary.unavailable}`);
    console.log(`  Skipped (fresh):   ${summary.skippedFresh}`);
    console.log(`  Written:           ${summary.written}`);
    console.log(`  Held (real title): ${summary.heldExistingTitle}`);
    console.log(`  Errors:            ${summary.errors}`);

    const withTitle = found.filter((f) => f.title);
    console.log();
    console.log(`Sample (${Math.min(15, withTitle.length)} of ${withTitle.length} with titles):`);
    for (const f of withTitle.slice(0, 15)) {
      console.log(`  - ${f.corpsKey} ${f.season}: "${f.title}" (${f.songs} songs)`);
    }

    results.push(summary);
  }

  if (source === "flomarching" || source === "all") {
    console.log();
    console.log("Running FloMarching scraper...");
    const floResult = yield* orchestrator.runFloMarchingIngestion(season);

    console.log();
    console.log("=== FloMarching Results ===");
    console.log(`  Enriched: ${floResult.enriched}`);
    console.log(`  Paywalled: ${floResult.paywalled}`);
    console.log(`  Errors: ${floResult.errors}`);

    results.push(floResult);
  }

  if (source === "agent" || source === "all") {
    console.log();
    console.log("Running Agent gap-fill scraper...");
    const agentResult = yield* orchestrator.runAgentIngestion(season);

    console.log();
    console.log("=== Agent Gap-Fill Results ===");
    console.log(`  Enriched: ${agentResult.enriched}`);
    console.log(`  Failed: ${agentResult.failed}`);

    results.push(agentResult);
  }

  if (source === "dciorg" || source === "all") {
    console.log();
    console.log("Running DCI.org scraper...");
    const dciOrgResult = yield* orchestrator.runDciOrgIngestion({ season });

    console.log();
    console.log("=== DCI.org Results ===");
    console.log(`  Articles found: ${dciOrgResult.articles}`);
    console.log(`  Ingested: ${dciOrgResult.ingested}`);
    console.log("  Note: DCI.org is blocked by Cloudflare; Browserbase integration needed");

    results.push(dciOrgResult);
  }

  if (report) {
    console.log();
    console.log("Generating coverage report...");
    const { report: coverageReport, text } = yield* orchestrator.generateReport({ season });
    console.log();
    console.log(text);
  }

  if (results.length === 0) {
    console.log(`Source '${source}' not recognized. Use: dcx, flomarching, agent, dciorg, all`);
  }

  return results;
});

// Build and run
const { AppLive, DatabaseLive } = makeShowLayers({ dbUrl: dbPath });

// Provide both the service layers and the base SqlClient layer
// (ensureRelationalSchema needs SqlClient directly)
Effect.runPromise(
  program.pipe(
    Effect.provide(AppLive),
    Effect.provide(DatabaseLive)
  )
)
  .then((results) => {
    console.log();
    console.log("Pipeline complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Pipeline failed:", err);
    process.exit(1);
  });
