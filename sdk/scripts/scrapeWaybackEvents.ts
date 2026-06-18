// Scrape Wayback Machine event data with robust retries.
// Usage: npx tsx scripts/scrapeWaybackEvents.ts [path/to/events.json]

import fs from "fs/promises";
import path from "path";
import { Effect, Schedule, Duration, Ref } from "effect";

const archiveBase = "https://web.archive.org/web";
const availabilityBase = "https://archive.org/wayback/available";
const apiBase = "https://api.dci.org/api/v1";

const config = {
  initialDelayMs: 500,
  maxDelayMs: 30000,
  backoffFactor: 1.5,
  maxRetries: 5,
  timeoutMs: 10000,
  queueConcurrency: 2,
  pageLimit: 1000,
  enhancedEndpoints: ["events", "competitions"]
};

const defaultInput = path.join("wayback", "wayback_dci_ultimate_merged.json");
const defaultOutput = path.join("wayback", "wayback_dci_ultimate_with_enrichment.json");

const parseNumberFlag = (args: string[], flag: string) => {
  const prefix = `${flag}=`;
  const raw = args.find((arg) => arg.startsWith(prefix));
  if (!raw) return undefined;
  const value = Number(raw.slice(prefix.length));
  return Number.isFinite(value) ? value : undefined;
};

const normalizeKey = (value: string | undefined | null) => {
  if (!value) return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const normalizeNameMatch = (value: string | undefined | null) =>
  (value ?? "").trim().toLowerCase().replace(/the/g, "").replace(/\s+/g, "");

const fetchJson = (url: string) =>
  Effect.tryPromise(() =>
    fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then(async (res) => {
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new Error(`HTTP ${res.status} ${retryable ? "retryable" : "non-retryable"}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("Non-JSON response");
      }
      return res.json();
    })
  );

const retrySchedule = Schedule.exponential(Duration.millis(config.initialDelayMs)).pipe(
  Schedule.compose(Schedule.recurs(config.maxRetries))
);

const fetchJsonWithRetry = (url: string) =>
  fetchJson(url).pipe(
    Effect.retry(retrySchedule),
    Effect.catch(() => Effect.succeed<unknown | null>(null))
  );

const parseEventsFile = (filePath: string) =>
  Effect.tryPromise(() => fs.readFile(filePath, "utf-8")).pipe(
    Effect.map((contents) => {
      const parsed = JSON.parse(contents) as { events?: unknown[] } | unknown[];
      const events = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
      return { contents, events };
    })
  );

const parseEventDate = (value?: string | null) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
};

const formatDateStamp = (date: Date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
};

const resolveEventDate = (event: Record<string, any>) =>
  parseEventDate(event.startDate ?? event.date ?? event.startTime ?? event.eventDate ?? event.start);

const buildFallbackDates = (target: Date) => {
  const midMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 15));
  return [target, midMonth];
};

const fetchClosestSnapshot = (url: string, targetDate: Date) =>
  Effect.gen(function* () {
    const timestamp = formatDateStamp(targetDate);
    const availabilityUrl = `${availabilityBase}?url=${encodeURIComponent(url)}&timestamp=${timestamp}`;
    const payload = (yield* (fetchJsonWithRetry(availabilityUrl))) as any;
    const closest = payload?.archived_snapshots?.closest;
    if (!closest?.timestamp) {
      return undefined;
    }
    return { timestamp: String(closest.timestamp), url: String(closest.url ?? "") };
  });

const findSnapshotForEndpoint = (endpoint: string, targetDate: Date) =>
  Effect.gen(function* () {
    const baseUrl = `${apiBase}/${endpoint}?limit=${config.pageLimit}&offset=0`;
    for (const date of buildFallbackDates(targetDate)) {
      const snapshot = yield* (fetchClosestSnapshot(baseUrl, date));
      if (snapshot) {
        return { ...snapshot, endpoint };
      }
    }
    return undefined;
  });

const fetchEndpointPage = (endpoint: string, timestamp: string, offset: number) =>
  Effect.gen(function* () {
    const url = `${archiveBase}/${timestamp}/${apiBase}/${endpoint}?limit=${config.pageLimit}&offset=${offset}`;
    const payload = (yield* (fetchJsonWithRetry(url))) as any;
    if (!payload) {
      return [] as unknown[];
    }
    if (Array.isArray(payload)) {
      return payload;
    }
    if (Array.isArray(payload.data)) {
      return payload.data;
    }
    return [];
  });

const fetchEndpointAtSnapshot = (endpoint: string, timestamp: string) =>
  Effect.gen(function* () {
    const all: unknown[] = [];
    let offset = 0;
    while (true) {
      const page = yield* (fetchEndpointPage(endpoint, timestamp, offset));
      if (page.length === 0) {
        break;
      }
      all.push(...page);
      if (page.length < config.pageLimit) {
        break;
      }
      offset += config.pageLimit;
    }
    return all;
  });

const findMatchingEvent = (
  records: ReadonlyArray<unknown>,
  inputEvent: Record<string, any>,
  endpoint: string
) => {
  const targetSlug = normalizeKey(inputEvent.slug ?? inputEvent.eventName ?? inputEvent.name ?? "");
  const targetName = normalizeNameMatch(inputEvent.eventName ?? inputEvent.name ?? "");
  const targetDate = parseEventDate(inputEvent.date ?? inputEvent.startDate);
  const targetYear = targetDate?.getUTCFullYear();

  return records.find((record) => {
    const entry = record as Record<string, any>;

    // Field mapping based on endpoint type
    const entrySlug = normalizeKey(entry.slug ?? entry.eventName ?? entry.name ?? "");
    const entryName = normalizeNameMatch(
      endpoint === "events" ? (entry.name ?? entry.eventName) : (entry.eventName ?? entry.name)
    );

    // Validate year matches
    const entryDate = parseEventDate(entry.startDate ?? entry.date);
    const entryYear = entryDate?.getUTCFullYear();
    const yearMatches = !targetYear || !entryYear || targetYear === entryYear;

    return yearMatches && (
      (targetSlug && entrySlug && targetSlug === entrySlug) ||
      (targetName && entryName && targetName === entryName)
    );
  }) as Record<string, any> | undefined;
};

const isFullEventObject = (obj: Record<string, any>): boolean => {
  // Check for key fields that distinguish full events from competitions
  const hasRequiredFields = Boolean(
    obj.id &&
    obj.name &&
    obj.slug &&
    obj.startDate &&
    obj.eDTStartTimeForAPI
  );

  // Events should have venue info (even if null)
  const hasVenueFields = 'venue' in obj || 'venueCity' in obj || 'venueState' in obj;

  // Count fields - events should have 50+ fields, competitions have ~12
  const fieldCount = Object.keys(obj).length;

  return hasRequiredFields && hasVenueFields && fieldCount > 30;
};

interface ProgressStats {
  readonly processed: number;
  readonly enriched: number;
  readonly skipped: number;
  readonly misses: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
}

const updateCacheStats = (stats: Ref.Ref<ProgressStats>, hit: boolean) =>
  Ref.update(stats, (current) => ({
    ...current,
    cacheHits: current.cacheHits + (hit ? 1 : 0),
    cacheMisses: current.cacheMisses + (hit ? 0 : 1)
  }));

const enrichEvent = (
  event: Record<string, any>,
  snapshotCache: Ref.Ref<Map<string, ReadonlyArray<unknown>>>,
  stats: Ref.Ref<ProgressStats>
) =>
  Effect.gen(function* () {
    const targetDate = resolveEventDate(event);
    if (!targetDate) {
      return { status: "skipped", event, reason: "missing-date" } as const;
    }

    for (const endpoint of config.enhancedEndpoints) {
      const snapshot = yield* (findSnapshotForEndpoint(endpoint, targetDate));
      if (!snapshot) {
        console.log(`  ℹ No ${endpoint} snapshot found for ${event.slug ?? event.eventName}`);
        continue;
      }

      const cacheKey = `${endpoint}:${snapshot.timestamp}`;
      const cached = yield* (Ref.get(snapshotCache));
      const existing = cached.get(cacheKey);
      if (existing) {
        yield* (updateCacheStats(stats, true));
      }
      const records =
        existing ??
        (yield* (fetchEndpointAtSnapshot(endpoint, snapshot.timestamp).pipe(
          Effect.tap((events) =>
            Ref.update(snapshotCache, (current) => {
              const next = new Map(current);
              next.set(cacheKey, events);
              return next;
            })
          ),
          Effect.tap(() => updateCacheStats(stats, false))
        )));

      console.log(`  ℹ ${endpoint}: ${records.length} records fetched from snapshot ${snapshot.timestamp}`);
      const enriched = findMatchingEvent(records, event, endpoint);
      if (enriched) {
        // If matched against events endpoint, validate and return full object
        if (endpoint === "events") {
          if (isFullEventObject(enriched)) {
            console.log(`✓ Full event: ${enriched.slug ?? enriched.name} (${Object.keys(enriched).length} fields)`);
            return {
              status: "enriched",
              source: "events" as const,
              event: {
                ...enriched,
                _wayback: {
                  snapshotTimestamp: snapshot.timestamp,
                  snapshotUrl: snapshot.url,
                  snapshotEndpoint: endpoint,
                  originalInputSlug: event.slug
                }
              }
            } as const;
          }
          // Validation failed - log and continue to next endpoint
          console.warn(`⚠ Events match failed validation: ${event.slug} (${Object.keys(enriched).length} fields)`);
          continue;
        }

        // If matched against competitions endpoint (fallback)
        console.log(`⚠ Competition fallback: ${event.slug}`);
        return {
          status: "enriched",
          source: "competitions" as const,
          event: {
            ...event,
            snapshotTimestamp: snapshot.timestamp,
            snapshotUrl: snapshot.url,
            snapshotEndpoint: endpoint,
            enriched
          }
        } as const;
      }
    }

    return { status: "miss", event } as const;
  });

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const nonFlags = args.filter((arg) => !arg.startsWith("--"));
  const inputPath = nonFlags[0] ?? defaultInput;
  const outputPath = nonFlags[1] ?? defaultOutput;
  const partialOutputPath = `${outputPath}.partial`;
  const limit = parseNumberFlag(args, "--limit");
  const offset = parseNumberFlag(args, "--offset") ?? 0;
  const includeAll = args.includes("--include-all");

  const { events } = yield* (parseEventsFile(inputPath));
  const snapshotCache = yield* (Ref.make(new Map<string, ReadonlyArray<unknown>>()));
  const stats = yield* (
    Ref.make({
      processed: 0,
      enriched: 0,
      skipped: 0,
      misses: 0,
      cacheHits: 0,
      cacheMisses: 0
    })
  );

  const filtered = includeAll
    ? events
    : events.filter((entry) => {
        const record = entry as Record<string, any>;
        const schedules = Array.isArray(record.schedules) ? record.schedules : [];
        const performances = Array.isArray(record.performances) ? record.performances : [];
        return schedules.length === 0 && performances.length === 0;
      });

  const sliced = filtered.slice(offset, limit ? offset + limit : undefined);
  const startTime = Date.now();

  console.log(
    `Starting Wayback enrichment for ${sliced.length} events ` +
      `(offset=${offset}, limit=${limit ?? "all"}, includeAll=${includeAll}).`
  );

  const logProgress = (current: ProgressStats) => {
    const elapsedMinutes = Math.max(1, (Date.now() - startTime) / 60000);
    const rate = Math.round(current.processed / elapsedMinutes);
    console.log(
      `[${current.processed}/${sliced.length}] enriched=${current.enriched} ` +
        `misses=${current.misses} skipped=${current.skipped} ` +
        `cacheHit=${current.cacheHits} cacheMiss=${current.cacheMisses} ` +
        `rate=${rate}/min`
    );
  };

  const resultsRef = yield* (Ref.make([] as Array<any>));

  const writeProgressSnapshot = (current: ProgressStats, results: ReadonlyArray<any>) => {
    const enriched = results.filter((entry) => entry.status === "enriched");
    const fullEvents = enriched.filter((entry) => entry.source === "events");
    const competitionFallbacks = enriched.filter((entry) => entry.source === "competitions");
    const skipped = results.filter((entry) => entry.status === "skipped");
    const misses = results.filter((entry) => entry.status === "miss");

    const output = {
      metadata: {
        description: "Wayback event enrichment - Full event objects from /api/v1/events (in progress)",
        captureDate: new Date().toISOString(),
        inputPath,
        totalEvents: events.length,
        filteredEvents: filtered.length,
        processedEvents: current.processed,
        offset,
        limit: limit ?? null,
        fullEventsMatched: fullEvents.length,
        competitionsMatched: competitionFallbacks.length,
        totalEnriched: enriched.length,
        skipped: skipped.length,
        misses: misses.length
      },
      events: fullEvents.map((entry) => entry.event),
      fullEvents: fullEvents.map((entry) => entry.event),
      competitionFallbacks: competitionFallbacks.map((entry) => entry.event),
      skipped: skipped.map((entry) => entry.event),
      misses: misses.map((entry) => entry.event)
    };
    return Effect.tryPromise(() => fs.writeFile(partialOutputPath, JSON.stringify(output, null, 2)));
  };

  const results = yield* (
    Effect.forEach(
      sliced,
      (event) =>
        Effect.gen(function* () {
          const result = yield* (enrichEvent(event as Record<string, any>, snapshotCache, stats));
          const updated = yield* (
            Ref.updateAndGet(stats, (current) => ({
              ...current,
              processed: current.processed + 1,
              enriched: current.enriched + (result.status === "enriched" ? 1 : 0),
              skipped: current.skipped + (result.status === "skipped" ? 1 : 0),
              misses: current.misses + (result.status === "miss" ? 1 : 0)
            }))
          );
          const resultsSoFar = yield* (Ref.updateAndGet(resultsRef, (current) => [...current, result]));
          if (updated.processed % 25 === 0 || updated.processed === sliced.length) {
            logProgress(updated);
            yield* (writeProgressSnapshot(updated, resultsSoFar));
          }
          return result;
        }),
      { concurrency: config.queueConcurrency }
    )
  );

  const enriched = results.filter((entry) => entry.status === "enriched");
  const fullEvents = enriched.filter((entry) => entry.source === "events");
  const competitionFallbacks = enriched.filter((entry) => entry.source === "competitions");
  const skipped = results.filter((entry) => entry.status === "skipped");
  const misses = results.filter((entry) => entry.status === "miss");

  const output = {
    metadata: {
      description: "Wayback event enrichment - Full event objects from /api/v1/events",
      captureDate: new Date().toISOString(),
      inputPath,
      totalEvents: events.length,
      filteredEvents: filtered.length,
      processedEvents: sliced.length,
      offset,
      limit: limit ?? null,
      fullEventsMatched: fullEvents.length,
      competitionsMatched: competitionFallbacks.length,
      totalEnriched: enriched.length,
      skipped: skipped.length,
      misses: misses.length
    },
    events: fullEvents.map((entry) => entry.event),
    fullEvents: fullEvents.map((entry) => entry.event),
    competitionFallbacks: competitionFallbacks.map((entry) => entry.event),
    skipped: skipped.map((entry) => entry.event),
    misses: misses.map((entry) => entry.event)
  };

  yield* (Effect.tryPromise(() => fs.writeFile(outputPath, JSON.stringify(output, null, 2))));

  console.log("Wayback enrichment complete.");
  console.log(`Input: ${inputPath}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Processed: ${sliced.length} / ${filtered.length}`);
  console.log(`Full Events: ${fullEvents.length} | Competition Fallbacks: ${competitionFallbacks.length}`);
  console.log(`Misses: ${misses.length} | Skipped: ${skipped.length}`);
});

Effect.runPromise(main).catch((error) => {
  console.error("Wayback enrichment failed:", error);
  process.exitCode = 1;
});
