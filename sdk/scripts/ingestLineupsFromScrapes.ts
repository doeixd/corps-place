// Compatibility wrapper for the current-lineup rebuild path.
// Reprocesses only the latest archived event-page scrape per event.
// Usage:
//   npx tsx scripts/ingestLineupsFromScrapes.ts --season 2026
//   npx tsx scripts/ingestLineupsFromScrapes.ts --slug 2026-example-event

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

const seasonFilter = argValue("season");
const slugFilter = argValue("slug");

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const result = yield* (
    rebuildLatestEventLineups(
      sql,
      {
        season: seasonFilter,
        slug: slugFilter
      },
      { apply: true }
    )
  );

  console.log(`Rebuilt ${result.applied.length} latest event lineup(s).`);
  if (seasonFilter) console.log(`  season: ${seasonFilter}`);
  if (slugFilter) console.log(`  slug: ${slugFilter}`);
  const changed = result.plans.filter((plan) => plan.wouldChange).length;
  console.log(`  changed before rebuild: ${changed}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Lineup ingest failed:", error);
  process.exitCode = 1;
});
