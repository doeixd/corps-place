// Extract events from Wayback Machine snapshots of the DCI events page
// The events page is a Nuxt app that embeds data in window.__NUXT__
// Usage: npx tsx scripts/scrapeWaybackWebpage.ts

import fs from "fs/promises";
import path from "path";
import { Effect, Schedule, Duration } from "effect";

const WAYBACK_BASE = "https://web.archive.org/web";
const DCI_EVENTS_URL = "https://www.dci.org/events";

const config = {
  initialDelayMs: 1000,
  maxRetries: 3,
  seasons: [2018, 2019, 2020, 2021, 2022, 2023, 2024],
  // Sample dates throughout the season (June-August)
  sampleDates: [
    { month: 6, day: 15 },
    { month: 7, day: 1 },
    { month: 7, day: 15 },
    { month: 8, day: 1 },
    { month: 8, day: 15 },
  ],
};

// Format date as YYYYMMDD for Wayback Machine
const formatWaybackDate = (year: number, month: number, day: number): string => {
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
};

// Extract window.__NUXT__ from HTML
const extractNuxtData = (html: string): any | null => {
  try {
    // Find where window.__NUXT__ starts
    const startMarker = "window.__NUXT__=";
    const startIdx = html.indexOf(startMarker);

    if (startIdx === -1) {
      return null;
    }

    // Extract from after the = sign until </script>
    const jsonStart = startIdx + startMarker.length;
    const scriptEnd = html.indexOf("</script>", jsonStart);

    if (scriptEnd === -1) {
      return null;
    }

    // Extract the JSON string and remove trailing semicolon if present
    let jsonStr = html.substring(jsonStart, scriptEnd).trim();
    if (jsonStr.endsWith(";")) {
      jsonStr = jsonStr.slice(0, -1);
    }

    // Parse the JSON
    const nuxtData = JSON.parse(jsonStr);
    return nuxtData;
  } catch (error) {
    console.error("  Error extracting NUXT data:", error instanceof Error ? error.message : error);
    return null;
  }
};

// Extract events and pagination info from NUXT data
const extractEventsAndPagination = (nuxtData: any): { events: any[], currentPage: number, totalPages: number } => {
  try {
    const listing = nuxtData?.state?.events?.listing;

    if (!listing) {
      return { events: [], currentPage: 1, totalPages: 1 };
    }

    const events = Array.isArray(listing.events) ? listing.events : [];
    const currentPage = listing.currentPage ?? 1;
    const totalPages = listing.totalPages ?? 1;

    return { events, currentPage, totalPages };
  } catch (error) {
    console.error("  Error extracting events:", error instanceof Error ? error.message : error);
    return { events: [], currentPage: 1, totalPages: 1 };
  }
};

// Fetch webpage snapshot from Wayback Machine
const fetchWaybackPage = (timestamp: string, page?: number) =>
  Effect.tryPromise(async () => {
    const pageParam = page && page > 1 ? `?page=${page}` : "";
    const url = `${WAYBACK_BASE}/${timestamp}/${DCI_EVENTS_URL}${pageParam}`;

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    return html;
  });

const retrySchedule = Schedule.exponential(Duration.millis(config.initialDelayMs)).pipe(
  Schedule.compose(Schedule.recurs(config.maxRetries))
);

const fetchWithRetry = (timestamp: string, page?: number) =>
  fetchWaybackPage(timestamp, page).pipe(
    Effect.retry(retrySchedule),
    Effect.catch((error) => {
      const pageStr = page && page > 1 ? ` page ${page}` : "";
      console.error(`  Failed to fetch ${timestamp}${pageStr}:`, error);
      return Effect.succeed(null);
    })
  );

const main = Effect.gen(function* () {
  console.log("Starting Wayback webpage scraping with pagination...");
  console.log(`Seasons: ${config.seasons.join(", ")}`);
  console.log(`Sample dates per season: ${config.sampleDates.length}`);

  const allEvents = new Map<string, any>(); // Deduplicate by event id/slug
  const failures: Array<{ year: number, month: number, day: number, page?: number, reason: string }> = [];
  let totalPagesProcessed = 0;

  for (const year of config.seasons) {
    console.log(`\n=== Season ${year} ===`);

    for (const { month, day } of config.sampleDates) {
      const timestamp = formatWaybackDate(year, month, day);
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      console.log(`\nProcessing ${dateStr}...`);

      // Fetch first page to get total pages
      const html = yield* (fetchWithRetry(timestamp));

      if (!html) {
        failures.push({ year, month, day, reason: "No snapshot found" });
        console.log("  ✗ Skipped (no snapshot)");
        continue;
      }

      const nuxtData = extractNuxtData(html);
      if (!nuxtData) {
        failures.push({ year, month, day, reason: "No NUXT data in HTML" });
        console.log("  ✗ No NUXT data found");
        continue;
      }

      const { events: firstPageEvents, totalPages } = extractEventsAndPagination(nuxtData);
      console.log(`  Found ${totalPages} page(s) with ${firstPageEvents.length} events on page 1`);

      // Add first page events
      let newEventsCount = 0;
      for (const event of firstPageEvents) {
        const key = event.id || event.slug || event.eventName;
        if (key && !allEvents.has(key)) {
          allEvents.set(key, {
            ...event,
            _waybackSource: {
              timestamp,
              year,
              month,
              day,
              page: 1,
            },
          });
          newEventsCount++;
        }
      }
      totalPagesProcessed++;

      // Fetch remaining pages if any
      if (totalPages > 1) {
        for (let page = 2; page <= totalPages; page++) {
          console.log(`  Fetching page ${page}/${totalPages}...`);

          const pageHtml = yield* (fetchWithRetry(timestamp, page));

          if (!pageHtml) {
            failures.push({ year, month, day, page, reason: "Failed to fetch page" });
            console.log(`    ✗ Failed to fetch page ${page}`);
            continue;
          }

          const pageNuxtData = extractNuxtData(pageHtml);
          if (!pageNuxtData) {
            failures.push({ year, month, day, page, reason: "No NUXT data on page" });
            console.log(`    ✗ No NUXT data on page ${page}`);
            continue;
          }

          const { events: pageEvents } = extractEventsAndPagination(pageNuxtData);
          console.log(`    Found ${pageEvents.length} events`);

          for (const event of pageEvents) {
            const key = event.id || event.slug || event.eventName;
            if (key && !allEvents.has(key)) {
              allEvents.set(key, {
                ...event,
                _waybackSource: {
                  timestamp,
                  year,
                  month,
                  day,
                  page,
                },
              });
              newEventsCount++;
            }
          }

          totalPagesProcessed++;

          // Wait between page requests
          yield* (Effect.sleep(Duration.millis(300)));
        }
      }

      console.log(`  ✓ Added ${newEventsCount} new events (total: ${allEvents.size})`);

      // Wait between date requests
      yield* (Effect.sleep(Duration.millis(500)));
    }
  }

  // Save events to JSON file
  const outputPath = path.join("wayback", "wayback_dci_events_from_webpage_v2.json");
  const output = {
    metadata: {
      description: "Events extracted from Wayback Machine snapshots of dci.org/events page (with pagination)",
      captureDate: new Date().toISOString(),
      totalEvents: allEvents.size,
      totalPagesProcessed,
      seasons: config.seasons,
      sampleDates: config.sampleDates,
      failuresCount: failures.length,
    },
    events: Array.from(allEvents.values()),
    failures,
  };

  yield* (Effect.tryPromise(() =>
    fs.writeFile(outputPath, JSON.stringify(output, null, 2))
  ));

  console.log(`\n=== Complete ===`);
  console.log(`Total unique events extracted: ${allEvents.size}`);
  console.log(`Total pages processed: ${totalPagesProcessed}`);
  console.log(`Failures: ${failures.length}`);
  console.log(`Events saved to: ${outputPath}`);

  if (failures.length > 0) {
    console.log(`\nFailed fetches:`);
    failures.forEach(f => {
      const pageStr = f.page ? ` page ${f.page}` : "";
      console.log(`  ${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}${pageStr}: ${f.reason}`);
    });
  }

  console.log(`\nTo ingest these events into the database, run:`);
  console.log(`  npx tsx scripts/ingestWaybackEvents.ts ${outputPath}`);
});

Effect.runPromise(main).catch((error) => {
  console.error("Failed:", error);
  process.exitCode = 1;
});
