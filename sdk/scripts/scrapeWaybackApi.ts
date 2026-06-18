// Extract events from Wayback Machine snapshots of the DCI API endpoint
// The API returns JSON arrays of full event objects
// Usage: npx tsx scripts/scrapeWaybackApi.ts

import fs from "fs/promises";
import path from "path";
import { Effect, Schedule, Duration } from "effect";

const WAYBACK_BASE = "https://web.archive.org";
const WAYBACK_CDX = `${WAYBACK_BASE}/cdx/search/cdx`;
const API_HOST = "api.dci.org/api/v1/events";
const INPUT_PATH = path.join("wayback", "archived_events.html");

const config = {
  initialDelayMs: 500,
  maxRetries: 3,
  requestDelayMs: 100,
  cdxDelayMs: 150,
};

type WaybackEntry = {
  waybackUrl: string;
  apiUrl: string;
  timestamp: string;
};

type SnapshotRecord = {
  timestamp: string;
  apiUrl: string;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const parseWaybackUrl = (url: string): WaybackEntry | null => {
  const match = url.match(/\/web\/(\d{14})\/(https?:\/\/.+)$/);
  if (!match) {
    return null;
  }

  return {
    waybackUrl: url,
    timestamp: match[1],
    apiUrl: match[2],
  };
};

const parseArchivedEntries = (html: string): WaybackEntry[] => {
  const entries = new Map<string, WaybackEntry>();
  const hrefRegex = /href="([^"]+)"/g;

  for (const match of html.matchAll(hrefRegex)) {
    const rawHref = decodeHtmlEntities(match[1]);
    const absoluteHref = rawHref.startsWith("http")
      ? rawHref
      : `${WAYBACK_BASE}${rawHref.startsWith("/") ? "" : "/"}${rawHref}`;

    if (!absoluteHref.includes(API_HOST)) {
      continue;
    }

    const entry = parseWaybackUrl(absoluteHref);
    if (entry) {
      entries.set(entry.waybackUrl, entry);
    }
  }

  return Array.from(entries.values());
};

const dedupeApiUrls = (entries: WaybackEntry[]): string[] => {
  const apiUrls = new Set<string>();
  for (const entry of entries) {
    apiUrls.add(entry.apiUrl);
  }
  return Array.from(apiUrls.values());
};

const fetchSnapshotList = (apiUrl: string) =>
  Effect.tryPromise(async () => {
    const searchParams = new URLSearchParams({
      url: apiUrl,
      output: "json",
      fl: "timestamp,original",
      collapse: "digest",
    });
    searchParams.append("filter", "statuscode:200");
    searchParams.append("filter", "mimetype:application/json");

    const url = `${WAYBACK_CDX}?${searchParams.toString()}`;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as Array<[string, string]>;

      if (!Array.isArray(data) || data.length <= 1) {
        return [];
      }

      return data
        .slice(1)
        .map(([timestamp, original]) => ({ timestamp, apiUrl: original }));
    } catch {
      return null;
    }
  });

const fetchWaybackSnapshot = (waybackUrl: string) =>
  Effect.tryPromise(async () => {
    try {
      const response = await fetch(waybackUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (!response.ok) {
        return null;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return null;
      }

      const data = await response.json();
      const events = Array.isArray(data) ? data : data ? [data] : [];

      if (events.length === 0) {
        return null;
      }

      return { events, waybackUrl };
    } catch {
      return null;
    }
  });

const retrySchedule = Schedule.exponential(Duration.millis(config.initialDelayMs)).pipe(
  Schedule.compose(Schedule.recurs(config.maxRetries))
);

const fetchWithRetry = (waybackUrl: string) =>
  fetchWaybackSnapshot(waybackUrl).pipe(
    Effect.retry(retrySchedule),
    Effect.catch(() => Effect.succeed(null))
  );

const fetchSnapshotListWithRetry = (apiUrl: string) =>
  fetchSnapshotList(apiUrl).pipe(
    Effect.retry(retrySchedule),
    Effect.catch(() => Effect.succeed(null))
  );

const main = Effect.gen(function* () {
  console.log("Starting Wayback API scraping from archived_events.html...");

  const html = yield* (Effect.tryPromise(() => fs.readFile(INPUT_PATH, "utf8")));
  const entries = parseArchivedEntries(html);
  const apiUrls = dedupeApiUrls(entries);

  console.log(`Found ${entries.length} archived endpoints.`);
  console.log(`Fetching snapshots for ${apiUrls.length} unique API URLs.`);

  const snapshots = new Map<string, SnapshotRecord>();
  const cdxFailures: Array<{ apiUrl: string; reason: string }> = [];

  for (const apiUrl of apiUrls) {
    const result = yield* (fetchSnapshotListWithRetry(apiUrl));

    if (!result) {
      cdxFailures.push({ apiUrl, reason: "CDX request failed" });
      console.log(`  ✗ CDX ${apiUrl}`);
      yield* (Effect.sleep(Duration.millis(config.cdxDelayMs)));
      continue;
    }

    for (const snapshot of result) {
      const key = `${snapshot.timestamp}-${snapshot.apiUrl}`;
      snapshots.set(key, snapshot);
    }

    console.log(`  ✓ CDX ${apiUrl}: ${result.length} snapshots`);
    yield* (Effect.sleep(Duration.millis(config.cdxDelayMs)));
  }

  console.log(`Scraping ${snapshots.size} unique snapshots...`);

  const allEvents = new Map<string, any>();
  const failures: Array<{ waybackUrl: string; reason: string }> = [];
  const successes: Array<{
    waybackUrl: string;
    apiUrl: string;
    timestamp: string;
    eventCount: number;
  }> = [];

  for (const snapshot of snapshots.values()) {
    const waybackUrl = `${WAYBACK_BASE}/web/${snapshot.timestamp}/${snapshot.apiUrl}`;
    const result = yield* (fetchWithRetry(waybackUrl));

    if (!result) {
      failures.push({ waybackUrl, reason: "No JSON data" });
      console.log(`  ✗ ${waybackUrl}`);
      yield* (Effect.sleep(Duration.millis(config.requestDelayMs)));
      continue;
    }

    let newEvents = 0;
    for (const event of result.events) {
      const key = event.id || event.slug || event.name;
      if (key && !allEvents.has(key)) {
        allEvents.set(key, {
          ...event,
          _waybackSource: {
            timestamp: snapshot.timestamp,
            url: waybackUrl,
            apiUrl: snapshot.apiUrl,
          },
        });
        newEvents++;
      }
    }

    successes.push({
      waybackUrl,
      apiUrl: snapshot.apiUrl,
      timestamp: snapshot.timestamp,
      eventCount: result.events.length,
    });

    console.log(`  ✓ ${waybackUrl}: ${result.events.length} events (${newEvents} new)`);
    yield* (Effect.sleep(Duration.millis(config.requestDelayMs)));
  }

  const outputPath = path.join("wayback", "wayback_dci_events_from_api.json");
  const output = {
    metadata: {
      description: "Events extracted from all Wayback Machine snapshots for endpoints listed in archived_events.html",
      captureDate: new Date().toISOString(),
      totalEvents: allEvents.size,
      totalApiUrls: apiUrls.length,
      totalSnapshots: snapshots.size,
      successfulSnapshots: successes.length,
      failedSnapshots: failures.length,
      cdxFailures: cdxFailures.length,
    },
    events: Array.from(allEvents.values()),
    successes,
    failures,
    cdxFailures,
  };

  yield* (Effect.tryPromise(() => fs.writeFile(outputPath, JSON.stringify(output, null, 2))));

  console.log("\n=== Complete ===");
  console.log(`Total unique events extracted: ${allEvents.size}`);
  console.log(`Snapshots scraped: ${snapshots.size}`);
  console.log(`Successful snapshots: ${successes.length}`);
  console.log(`Failed snapshots: ${failures.length}`);
  console.log(`CDX failures: ${cdxFailures.length}`);
  console.log(`Events saved to: ${outputPath}`);
  console.log("\nTo ingest these events into the database, run:");
  console.log(`  npx tsx scripts/ingestWaybackEvents.ts ${outputPath}`);
});

Effect.runPromise(main).catch((error) => {
  console.error("Failed:", error);
  process.exitCode = 1;
});
