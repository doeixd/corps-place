// Check if wayback events are in the database
// Usage: npx tsx scripts/checkWaybackEvents.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

interface DbEvent {
  slug: string;
  season: string | null;
  location_city: string | null;
  location_state: string | null;
  event_image: string | null;
  buy_tickets: string | null;
  min_ticket_price: number | null;
  max_ticket_price: number | null;
}

const checkWaybackEvents = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    console.log("=== Checking Wayback API Events in Database ===\n");

    // Load wayback events
    const waybackData = JSON.parse(
      fs.readFileSync("wayback/wayback_dci_events_from_api.json", "utf-8")
    );

    const waybackEvents = waybackData.events || [];
    console.log(`Wayback API events in JSON: ${waybackEvents.length}`);

    // Get all events from database with key fields
    const dbEvents = yield* (
      sql<DbEvent>`
        SELECT
          slug,
          season,
          location_city,
          location_state,
          event_image,
          buy_tickets,
          min_ticket_price,
          max_ticket_price
        FROM events
      `
    );

    const dbBySlug = new Map(dbEvents.map((e) => [e.slug, e]));
    console.log(`Events in database: ${dbBySlug.size}\n`);

    // Check which wayback events are in DB and data completeness
    let inDb = 0;
    let notInDb = 0;
    let missingData = 0;
    const missingEvents: any[] = [];
    const incompleteEvents: Array<{
      event: any;
      dbEvent: DbEvent;
      missingFields: string[];
    }> = [];

    for (const event of waybackEvents) {
      const slug = event.slug;
      if (!slug) {
        console.log("⚠️  Event without slug:", event.name || event.id);
        continue;
      }

      const dbEvent = dbBySlug.get(slug);
      if (!dbEvent) {
        notInDb++;
        missingEvents.push(event);
        continue;
      }

      inDb++;

      // Check data completeness
      const missing: string[] = [];

      if (event.locationCity && !dbEvent.location_city) {
        missing.push("location_city");
      }
      if (event.locationState && !dbEvent.location_state) {
        missing.push("location_state");
      }
      if (event.eventImage && !dbEvent.event_image) {
        missing.push("event_image");
      }
      if (event.buyTickets && !dbEvent.buy_tickets) {
        missing.push("buy_tickets");
      }
      if (event.minTicketPrice !== undefined && event.minTicketPrice !== null && !dbEvent.min_ticket_price) {
        missing.push("min_ticket_price");
      }
      if (event.maxTicketPrice !== undefined && event.maxTicketPrice !== null && !dbEvent.max_ticket_price) {
        missing.push("max_ticket_price");
      }
      if (event.season && !dbEvent.season) {
        missing.push("season");
      }

      if (missing.length > 0) {
        missingData++;
        incompleteEvents.push({ event, dbEvent, missingFields: missing });
      }
    }

    console.log(`✅ In database: ${inDb} (${((inDb / waybackEvents.length) * 100).toFixed(1)}%)`);
    console.log(`❌ Not in database: ${notInDb} (${((notInDb / waybackEvents.length) * 100).toFixed(1)}%)`);
    console.log(`⚠️  In DB but missing data: ${missingData} (${((missingData / waybackEvents.length) * 100).toFixed(1)}%)\n`);

    if (missingEvents.length > 0) {
      console.log("=== Missing Events (first 20) ===");
      missingEvents.slice(0, 20).forEach((event) => {
        console.log(`${event.slug || event.id}`);
        console.log(`  Name: ${event.name}`);
        console.log(`  Date: ${event.startDate}`);
        console.log(`  Season: ${event.season}`);
        console.log();
      });

      if (missingEvents.length > 20) {
        console.log(`... and ${missingEvents.length - 20} more\n`);
      }

      // Save missing events
      fs.writeFileSync(
        "missing_wayback_api_events.json",
        JSON.stringify(missingEvents, null, 2)
      );
      console.log(`📝 Saved all missing events to missing_wayback_api_events.json`);

      // Group missing by season
      console.log("\n=== Missing Events by Season ===");
      const bySeason = new Map<string, number>();
      for (const event of missingEvents) {
        const season = event.season || "unknown";
        bySeason.set(season, (bySeason.get(season) || 0) + 1);
      }

      Array.from(bySeason.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .forEach(([season, count]) => {
          console.log(`  ${season}: ${count} events`);
        });
    }

    // Report incomplete events
    if (incompleteEvents.length > 0) {
      console.log("\n=== Events with Incomplete Data (first 20) ===");
      incompleteEvents.slice(0, 20).forEach(({ event, dbEvent, missingFields }) => {
        console.log(`${dbEvent.slug}`);
        console.log(`  Name: ${event.name}`);
        console.log(`  Missing fields: ${missingFields.join(", ")}`);
        console.log();
      });

      if (incompleteEvents.length > 20) {
        console.log(`... and ${incompleteEvents.length - 20} more\n`);
      }

      // Count missing field frequency
      console.log("=== Most Common Missing Fields ===");
      const fieldCount = new Map<string, number>();
      for (const { missingFields } of incompleteEvents) {
        for (const field of missingFields) {
          fieldCount.set(field, (fieldCount.get(field) || 0) + 1);
        }
      }

      Array.from(fieldCount.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach(([field, count]) => {
          console.log(`  ${field}: ${count} events (${((count / incompleteEvents.length) * 100).toFixed(1)}%)`);
        });

      // Save incomplete events
      fs.writeFileSync(
        "incomplete_wayback_api_events.json",
        JSON.stringify(
          incompleteEvents.map((e) => ({
            slug: e.dbEvent.slug,
            name: e.event.name,
            missingFields: e.missingFields,
            jsonData: e.event
          })),
          null,
          2
        )
      );
      console.log(`\n📝 Saved incomplete events to incomplete_wayback_api_events.json`);
    }

    // Summary
    console.log("\n=== Summary ===");
    if (notInDb === 0 && missingData === 0) {
      console.log("✅ All wayback API events are in database with complete data!");
    } else {
      if (notInDb > 0) {
        console.log(`❌ ${notInDb} events need to be ingested`);
      }
      if (missingData > 0) {
        console.log(`⚠️  ${missingData} events need data updates`);
      }
    }
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (checkWaybackEvents(sql));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log("\n✨ Check complete!");
  })
  .catch((err) => {
    console.error("\n❌ Check failed:", err);
    process.exitCode = 1;
  });
