// Update missing data from wayback webpage events into database
// Usage: npx tsx scripts/updateMissingWebpageData.ts [--dryRun]

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dryRun");

interface IncompleteEvent {
  slug: string;
  name: string;
  missingFields: string[];
  jsonData: any;
}

const updateMissingData = (sql: SqlClient.SqlClient, dryRun: boolean) =>
  Effect.gen(function* () {
    console.log("=== Updating Missing Webpage Event Data ===\n");

    if (dryRun) {
      console.log("🔍 DRY RUN MODE - No changes will be made\n");
    }

    // Load incomplete events
    const incompleteEvents: IncompleteEvent[] = JSON.parse(
      fs.readFileSync("incomplete_webpage_events.json", "utf-8")
    );

    console.log(`Events to update: ${incompleteEvents.length}\n`);

    let updated = 0;
    const updates: Array<{ slug: string; fields: string[] }> = [];

    for (const incomplete of incompleteEvents) {
      const { slug, missingFields, jsonData } = incomplete;

      console.log(`Updating: ${slug}`);
      console.log(`  Missing: ${missingFields.join(", ")}`);

      // Build update object based on missing fields
      const updateFields: Record<string, any> = {};

      for (const field of missingFields) {
        switch (field) {
          case "season":
            if (jsonData.season) {
              updateFields.season = jsonData.season;
              console.log(`    season: "${jsonData.season}"`);
            }
            break;
          case "location_city":
            if (jsonData.locationCity) {
              updateFields.location_city = jsonData.locationCity;
              console.log(`    location_city: "${jsonData.locationCity}"`);
            }
            break;
          case "location_state":
            if (jsonData.locationState) {
              updateFields.location_state = jsonData.locationState;
              console.log(`    location_state: "${jsonData.locationState}"`);
            }
            break;
          case "event_image":
            if (jsonData.eventImage) {
              updateFields.event_image = jsonData.eventImage;
              console.log(`    event_image: "${jsonData.eventImage.substring(0, 50)}..."`);
            }
            break;
          case "buy_tickets":
            if (jsonData.buyTickets) {
              updateFields.buy_tickets = jsonData.buyTickets;
              console.log(`    buy_tickets: "${jsonData.buyTickets.substring(0, 50)}..."`);
            }
            break;
          case "min_ticket_price":
            if (jsonData.minTicketPrice !== undefined && jsonData.minTicketPrice !== null) {
              updateFields.min_ticket_price = jsonData.minTicketPrice;
              console.log(`    min_ticket_price: ${jsonData.minTicketPrice}`);
            }
            break;
          case "max_ticket_price":
            if (jsonData.maxTicketPrice !== undefined && jsonData.maxTicketPrice !== null) {
              updateFields.max_ticket_price = jsonData.maxTicketPrice;
              console.log(`    max_ticket_price: ${jsonData.maxTicketPrice}`);
            }
            break;
        }
      }

      if (Object.keys(updateFields).length === 0) {
        console.log(`  ⚠️  No data available to update`);
        console.log();
        continue;
      }

      if (!dryRun) {
        // Build SET clause dynamically
        const setClauses: string[] = [];
        const values: any[] = [];

        for (const [key, value] of Object.entries(updateFields)) {
          setClauses.push(`${key} = ?`);
          values.push(value);
        }

        // Add slug for WHERE clause
        values.push(slug);

        const query = `UPDATE events SET ${setClauses.join(", ")} WHERE slug = ?`;

        yield* (
          sql.unsafe(query, values).pipe(Effect.asVoid)
        );

        updated++;
        updates.push({ slug, fields: Object.keys(updateFields) });
        console.log(`  ✅ Updated`);
      } else {
        console.log(`  🔍 Would update (dry run)`);
      }

      console.log();
    }

    console.log("=== Summary ===");
    console.log(`Events processed: ${incompleteEvents.length}`);
    console.log(`Events updated: ${updated}`);

    if (dryRun) {
      console.log(`\nDry run complete. Run without --dryRun to apply changes.`);
    } else {
      console.log(`\n✅ All updates complete!`);

      // Verify
      console.log("\n=== Verifying Updates ===");

      for (const { slug, fields } of updates.slice(0, 5)) {
        const result = yield* (
          sql.unsafe(`SELECT ${fields.join(", ")} FROM events WHERE slug = ?`, [slug])
        );

        if (result.length > 0) {
          console.log(`✓ ${slug}`);
          for (const field of fields) {
            console.log(`    ${field}: ${result[0][field] ? "✓" : "✗"}`);
          }
        }
      }

      if (updates.length > 5) {
        console.log(`\n... and ${updates.length - 5} more verified`);
      }
    }
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║   Update Missing Wayback Webpage Event Data       ║");
  console.log("╚════════════════════════════════════════════════════╝\n");

  yield* (updateMissingData(sql, dryRun));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log("\n✨ Done!");
  })
  .catch((err) => {
    console.error("\n❌ Update failed:", err);
    process.exitCode = 1;
  });
