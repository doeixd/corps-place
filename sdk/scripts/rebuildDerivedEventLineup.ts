// Rebuild current derived event lineup tables from the archived event-page scrape.
//
// Source of truth:
//   event_page_scrapes keeps every scrape version, keyed by (event_slug, scraped_at).
//
// Derived current state:
//   event_lineup_entries + event_participants are replaced from exactly one
//   canonical scrape per event: the latest scrape with non-empty lineup_json.
//
// Dry-run by default; pass --apply to write.

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { rebuildLatestEventLineups } from "../src/eventLineupRebuild.js";

const argValue = (name: string) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const apply = process.argv.includes("--apply");
const season = argValue("season");
const slug = argValue("slug");

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const result = yield* (rebuildLatestEventLineups(sql, { season, slug }, { apply }));
  const changed = result.plans.filter((plan) => plan.wouldChange);

  console.log(`${apply ? "Applied" : "Dry run"} derived lineup rebuild`);
  if (season) console.log(`  season: ${season}`);
  if (slug) console.log(`  slug: ${slug}`);
  console.log(`  candidate events: ${result.plans.length}`);
  console.log(`  would change: ${changed.length}`);
  if (apply) console.log(`  rebuilt: ${result.applied.length}`);

  for (const plan of changed.slice(0, 50)) {
    console.log(
      [
        `  - ${plan.scrape.event_slug}`,
        `current=${plan.currentRows}`,
        `target=${plan.targetRows}`,
        `source=${plan.scrape.scraped_at}`,
        `currentSources=${plan.currentSourceScrapedAt.join(",") || "none"}`
      ].join(" | ")
    );
  }

  if (changed.length > 50) {
    console.log(`  ... ${changed.length - 50} more`);
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Derived lineup rebuild failed:", error);
  process.exitCode = 1;
});
