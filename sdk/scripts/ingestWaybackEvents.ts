// scripts/ingestWaybackEvents.ts
// Ingest Wayback Machine event data into relational tables.
// Usage: npx tsx scripts/ingestWaybackEvents.ts [path/to/file.json] [--all] [--fetch-current-year]

import fs from "fs/promises";
import path from "path";
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ingestWaybackEvents } from "../src/relational.js";

const defaultPath = path.join("wayback", "wayback_dci_all_events_complete.json");
const args = process.argv.slice(2);
const useAll = args.includes("--all");
const fetchCurrentYear = args.includes("--fetch-current-year");
const explicitPath = args.find((arg) => !arg.startsWith("--"));
const filePath = explicitPath ?? defaultPath;

const WAYBACK_BASE = "https://web.archive.org/web";
const API_BASE = "https://api.dci.org/api/v1";
const WAYBACK_PARAMS = ["?sort=startDate&limit=0", "?limit=200", "?limit=500", "?sort=startDate", ""];

const readEventsFromFile = async (file: string) => {
  const fileContents = await fs.readFile(file, "utf-8");
  const parsed = JSON.parse(fileContents) as { events?: unknown[] } | unknown[];
  const events = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
  return { fileContents, events };
};

const fetchWaybackEvents = async (year: number, month: number) => {
  const timestamp = `${year}${String(month).padStart(2, "0")}15`;
  const endpoint = "/events";

  for (const params of WAYBACK_PARAMS) {
    const apiUrl = `${API_BASE}${endpoint}${params}`;
    const archiveUrl = `${WAYBACK_BASE}/${timestamp}/${apiUrl}`;

    try {
      const response = await fetch(archiveUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      if (!response.ok) {
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        continue;
      }
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return {
          events: data,
          endpointUrl: archiveUrl,
          responseJson: JSON.stringify(data)
        };
      }
    } catch {
      // Ignore and try next param
    }
  }

  return undefined;
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const eventMap = new Map<string, unknown>();
  const sources: Array<{ source: string; count: number }> = [];

  if (useAll) {
    const waybackDir = path.join("wayback");
    const files = yield* (Effect.tryPromise(() => fs.readdir(waybackDir)));
    const eventFiles = files
      .filter(
        (file) =>
          file.endsWith("__events.json") ||
          ((file.startsWith("wayback_dci_events") ||
            file.startsWith("wayback_dci_all_events")) &&
            file.endsWith(".json"))
      )
      .map((file) => path.join(waybackDir, file));

    for (const file of eventFiles) {
      const { events } = yield* (Effect.tryPromise(() => readEventsFromFile(file)));
      sources.push({ source: file, count: events.length });
      for (const event of events) {
        const record = event as Record<string, unknown>;
        const key = String(record.id ?? record.eventId ?? record.slug ?? record.name ?? "");
        if (!key || eventMap.has(key)) {
          continue;
        }
        eventMap.set(key, event);
      }
    }
  } else {
    const { events } = yield* (Effect.tryPromise(() => readEventsFromFile(filePath)));
    sources.push({ source: filePath, count: events.length });
    for (const event of events) {
      const record = event as Record<string, unknown>;
      const key = String(record.id ?? record.eventId ?? record.slug ?? record.name ?? "");
      if (!key || eventMap.has(key)) {
        continue;
      }
      eventMap.set(key, event);
    }
  }

  if (fetchCurrentYear) {
    const now = new Date();
    const year = now.getFullYear();
    const result = yield* (Effect.tryPromise(() => fetchWaybackEvents(year, 8)));
    if (result) {
      sources.push({ source: result.endpointUrl, count: result.events.length });
      for (const event of result.events) {
        const record = event as Record<string, unknown>;
        const key = String(record.id ?? record.eventId ?? record.slug ?? record.name ?? "");
        if (!key || eventMap.has(key)) {
          continue;
        }
        eventMap.set(key, event);
      }
    } else {
      console.warn(`No Wayback events found for ${year}-08.`);
    }
  }

  const events = Array.from(eventMap.values());
  const responseJson = JSON.stringify({ sources, events });

  console.log(`Prepared ${events.length} unique events from ${sources.length} sources.`);

  yield* (
    ingestWaybackEvents(sql, events, {
      endpointUrl: useAll ? "wayback://combined" : `wayback://${path.basename(filePath)}`,
      responseJson,
      recordCount: events.length
    })
  );

  console.log("Wayback event ingestion complete.");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(Effect.provide(SqlLayer));

Effect.runPromise(program)
  .then(() => {
    console.log("Done!");
  })
  .catch((err) => {
    console.error("Wayback ingest failed:", err);
    process.exitCode = 1;
  });
