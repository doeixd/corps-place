// Backfill performance_order from existing event_page_scrapes lineup_json
// Usage: npx tsx scripts/backfillPerformanceOrder.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const normalizeKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Fetching event page scrapes with lineup data...");
  const scrapes = yield* (sql<{
    event_slug: string;
    lineup_json: string;
  }>`
    SELECT event_slug, lineup_json
    FROM event_page_scrapes
    WHERE lineup_json IS NOT NULL
      AND json_array_length(lineup_json) > 0
  `);

  console.log(`Found ${scrapes.length} events with lineup data.`);

  let updatedEntries = 0;
  let updatedParticipants = 0;
  let errors = 0;

  for (const scrape of scrapes) {
    try {
      const lineup = JSON.parse(scrape.lineup_json) as Array<{
        corpsName?: string;
        order?: number;
        isNonPerformance?: boolean;
      }>;

      for (let index = 0; index < lineup.length; index++) {
        const entry = lineup[index];
        if (!entry || !entry.corpsName) continue;

        const corpsName = entry.corpsName.trim();
        const order = entry.order ?? null;
        const entryKey = normalizeKey(corpsName) ?? String(index + 1);
        const entryId = `${scrape.event_slug}-${entryKey}-${index}`;

        // Update event_lineup_entries
        const entryResult = yield* (sql`
          UPDATE event_lineup_entries
          SET performance_order = ${order}
          WHERE entry_id = ${entryId}
        `);

        if (entryResult.length > 0 || (entryResult as any).changes > 0) {
          updatedEntries++;
        }

        // Update event_participants if not a non-performance entry
        if (!entry.isNonPerformance) {
          const participantId = normalizeKey(corpsName) ?? corpsName.toLowerCase();
          const participantResult = yield* (sql`
            UPDATE event_participants
            SET performance_order = ${order}
            WHERE event_slug = ${scrape.event_slug}
              AND participant_id = ${participantId}
          `);

          if (participantResult.length > 0 || (participantResult as any).changes > 0) {
            updatedParticipants++;
          }
        }
      }

      if ((updatedEntries + updatedParticipants) % 100 === 0) {
        console.log(`Progress: ${updatedEntries} entries, ${updatedParticipants} participants updated...`);
      }
    } catch (error) {
      errors++;
      console.error(`Error processing ${scrape.event_slug}:`, error);
    }
  }

  console.log(`\nBackfill complete!`);
  console.log(`  Updated event_lineup_entries: ${updatedEntries}`);
  console.log(`  Updated event_participants: ${updatedParticipants}`);
  console.log(`  Errors: ${errors}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Backfill failed:", error);
  process.exitCode = 1;
});
