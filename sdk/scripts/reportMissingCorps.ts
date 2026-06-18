// Report corps names from scraped lineups that are missing in the corps table.
// Usage: npx tsx scripts/reportMissingCorps.ts [output.json]

import fs from "fs/promises";
import path from "path";
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { matchExistingCorpsKey } from "../src/relational.js";

const normalizeKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const buildMissingKey = (name: string, location?: string) =>
  `${normalizeKey(name)}|${normalizeKey(location ?? "")}`;

const main = Effect.gen(function* () {
  const outputArg = process.argv[2];
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : path.resolve("wayback", "missing_corps.json");

  const sql = yield* (SqlClient.SqlClient);

  const rows = yield* (
    sql<{ event_slug: string; lineup_json: string | null }>`
      SELECT eps.event_slug AS event_slug, eps.lineup_json AS lineup_json
      FROM event_page_scrapes eps
      JOIN (
        SELECT event_slug, MAX(scraped_at) AS scraped_at
        FROM event_page_scrapes
        GROUP BY event_slug
      ) latest
        ON latest.event_slug = eps.event_slug
       AND latest.scraped_at = eps.scraped_at
      WHERE eps.lineup_json IS NOT NULL
        AND eps.lineup_json != '[]'
    `.pipe(Effect.map((result) => result))
  );

  console.log(`Scanning ${rows.length} scraped lineup sets...`);

  const missingMap = new Map<
    string,
    { name: string; location?: string; events: Set<string> }
  >();

  for (const row of rows) {
    if (!row.lineup_json) continue;
    let lineup: Array<{ corpsName?: string; corpsCity?: string; isNonPerformance?: boolean }> = [];
    try {
      lineup = JSON.parse(row.lineup_json) as Array<{
        corpsName?: string;
        corpsCity?: string;
        isNonPerformance?: boolean;
      }>;
    } catch {
      continue;
    }

    for (const entry of lineup) {
      if (entry.isNonPerformance) continue;
      const name = entry.corpsName?.trim();
      if (!name) continue;
      const location = entry.corpsCity?.trim();
      const existing = yield* (matchExistingCorpsKey(sql, { name, location }));
      if (existing) continue;

      const key = buildMissingKey(name, location);
      const current = missingMap.get(key) ?? {
        name,
        location,
        events: new Set<string>()
      };
      current.events.add(row.event_slug);
      missingMap.set(key, current);
    }
  }

  const missingList = Array.from(missingMap.values()).map((entry) => ({
    name: entry.name,
    location: entry.location ?? null,
    events: Array.from(entry.events).sort()
  }));

  missingList.sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    generatedAt: new Date().toISOString(),
    missingCount: missingList.length,
    missing: missingList
  };

  yield* (Effect.tryPromise(() => fs.writeFile(outputPath, JSON.stringify(output, null, 2))));

  console.log(`Missing corps report written to ${outputPath}`);
  console.log(`Missing corps entries: ${missingList.length}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Missing corps report failed:", error);
  process.exitCode = 1;
});
