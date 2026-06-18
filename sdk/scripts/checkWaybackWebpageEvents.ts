// Check if wayback webpage events are in the database with full data
// Usage: npx tsx scripts/checkWaybackWebpageEvents.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as fs from "fs";

interface WebpageEvent {
  id: string;
  slug?: string;
  name: string;
  startDate: string;
  season: string;
  locationCity?: string;
  locationState?: string;
  attendance?: number;
  minTicketPrice?: number;
  maxTicketPrice?: number;
  eventImage?: string;
  buyTickets?: string;
  // Add more fields as needed
}

interface DbEvent {
  event_id: string;
  slug: string;
  name: string;
  start_date: string;
  season: string | null;
  location_city: string | null;
  location_state: string | null;
  event_image: string | null;
  buy_tickets: string | null;
  min_ticket_price: number | null;
  max_ticket_price: number | null;
  venue_city: string | null;
  venue_state: string | null;
}

const checkWaybackWebpageEvents = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    console.log("=== Checking Wayback Webpage Events in Database ===\n");

    // Load wayback webpage events
    const webpageData = JSON.parse(
      fs.readFileSync("wayback/wayback_dci_events_from_webpage_v2.json", "utf-8")
    );

    const webpageEvents: WebpageEvent[] = webpageData.events || [];
    console.log(`Wayback webpage events in JSON: ${webpageEvents.length}`);

    // Get all events from database with key fields
    const dbEvents = yield* (
      sql<DbEvent>`
        SELECT
          event_id,
          slug,
          name,
          start_date,
          season,
          location_city,
          location_state,
          event_image,
          buy_tickets,
          min_ticket_price,
          max_ticket_price,
          venue_city,
          venue_state
        FROM events
      `
    );

    console.log(`Events in database: ${dbEvents.length}\n`);

    // Create lookup maps
    const dbById = new Map(dbEvents.map((e) => [e.event_id, e]));
    const dbBySlug = new Map(dbEvents.map((e) => [e.slug, e]));

    // Check events
    let inDb = 0;
    let notInDb = 0;
    let missingData = 0;
    const missingEvents: WebpageEvent[] = [];
    const incompleteEvents: Array<{
      event: WebpageEvent;
      dbEvent: DbEvent;
      missingFields: string[];
    }> = [];

    console.log("=== Checking Events ===\n");

    for (const event of webpageEvents) {
      // Try to find event by ID or slug
      let dbEvent = dbById.get(event.id);
      if (!dbEvent && event.slug) {
        dbEvent = dbBySlug.get(event.slug);
      }

      if (!dbEvent) {
        notInDb++;
        missingEvents.push(event);
        continue;
      }

      inDb++;

      // Check data completeness
      const missing: string[] = [];

      // Check key fields that should be populated
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

    console.log(`✅ In database: ${inDb} (${((inDb / webpageEvents.length) * 100).toFixed(1)}%)`);
    console.log(`❌ Not in database: ${notInDb} (${((notInDb / webpageEvents.length) * 100).toFixed(1)}%)`);
    console.log(`⚠️  In DB but missing data: ${missingData} (${((missingData / webpageEvents.length) * 100).toFixed(1)}%)\n`);

    // Report missing events
    if (missingEvents.length > 0) {
      console.log("=== Missing Events (first 20) ===");
      missingEvents.slice(0, 20).forEach((event) => {
        console.log(`${event.slug || event.id}`);
        console.log(`  Name: ${event.name}`);
        console.log(`  Date: ${event.startDate}`);
        console.log(`  Season: ${event.season}`);
        console.log(`  Location: ${event.locationCity}, ${event.locationState}`);
        console.log();
      });

      if (missingEvents.length > 20) {
        console.log(`... and ${missingEvents.length - 20} more\n`);
      }

      // Group by season
      console.log("=== Missing Events by Season ===");
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

      // Save missing events
      fs.writeFileSync(
        "missing_webpage_events.json",
        JSON.stringify(missingEvents, null, 2)
      );
      console.log(`\n📝 Saved all missing events to missing_webpage_events.json`);
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
        "incomplete_webpage_events.json",
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
      console.log(`\n📝 Saved incomplete events to incomplete_webpage_events.json`);
    }

    // Summary
    console.log("\n=== Summary ===");
    if (notInDb === 0 && missingData === 0) {
      console.log("✅ All webpage events are in database with complete data!");
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
  yield* (checkWaybackWebpageEvents(sql));
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
