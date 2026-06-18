import { Context, Effect, Layer, Metric } from "effect";

import type { CacheNamespace } from "./config.js";
import type { DciError } from "./errors.js";

export interface DciObservability {
  readonly requestStart: (path: string) => Effect.Effect<void>;
  readonly requestSuccess: (path: string, status: number, durationMs: number) => Effect.Effect<void>;
  readonly requestFailure: (path: string, error: DciError, durationMs: number) => Effect.Effect<void>;
  readonly pagination: (path: string, page: number, totalPages: number) => Effect.Effect<void>;
  readonly cacheLookup: (namespace: CacheNamespace, key: string) => Effect.Effect<void>;
  readonly cachePopulate: (namespace: CacheNamespace, key: string) => Effect.Effect<void>;
  readonly cacheHit: (namespace: CacheNamespace, key: string) => Effect.Effect<void>;
  readonly cacheMiss: (namespace: CacheNamespace, key: string) => Effect.Effect<void>;
}

export const DciObservability = Context.Service<DciObservability>("DciObservability");

const noop: DciObservability = {
  requestStart: () => Effect.void,
  requestSuccess: () => Effect.void,
  requestFailure: () => Effect.void,
  pagination: () => Effect.void,
  cacheLookup: () => Effect.void,
  cachePopulate: () => Effect.void,
  cacheHit: () => Effect.void,
  cacheMiss: () => Effect.void
};

export const DciObservabilityNoop = noop;
export const DciObservabilityNoopLayer = Layer.succeed(DciObservability, noop);

export interface LoggerObservabilityOptions {
  readonly level?: "debug" | "info";
}

const logAtLevel = (level: "debug" | "info", message: string, fields: Record<string, unknown>) => {
  const formatted = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

  const entry = `[dci] ${message}${formatted ? " " + formatted : ""}`;
  return level === "debug" ? Effect.logDebug(entry) : Effect.logInfo(entry);
};

export const makeLoggerObservability = (options?: LoggerObservabilityOptions): DciObservability => {
  const level = options?.level ?? "debug";
  return {
    requestStart: (path) => logAtLevel(level, "http.start", { path }),
    requestSuccess: (path, status, durationMs) =>
      logAtLevel(level, "http.success", { path, status, durationMs }),
    requestFailure: (path, error, durationMs) =>
      logAtLevel("info", "http.failure", {
        path,
        durationMs,
        error: error._tag,
        message: error.message
      }),
    pagination: (path, page, totalPages) =>
      logAtLevel(level, "pagination", { path, page, totalPages }),
    cacheLookup: (namespace, key) => logAtLevel(level, "cache.lookup", { namespace, key }),
    cachePopulate: (namespace, key) => logAtLevel(level, "cache.populate", { namespace, key }),
    cacheHit: (namespace, key) => logAtLevel(level, "cache.hit", { namespace, key }),
    cacheMiss: (namespace, key) => logAtLevel(level, "cache.miss", { namespace, key })
  };
};

export const DciObservabilityLoggerLayer = (options?: LoggerObservabilityOptions) =>
  Layer.succeed(DciObservability, makeLoggerObservability(options));

const defaultHistogramBoundaries = Metric.linearBoundaries({
  start: 0,
  width: 25,
  count: 40
});

export interface TelemetryObservabilityOptions {
  readonly logLevel?: "debug" | "info";
  readonly histogram?: ReadonlyArray<number>;
}

export const makeTelemetryObservability = (
  options?: TelemetryObservabilityOptions
): DciObservability => {
  const level = options?.logLevel ?? "debug";
  const histogramBoundaries = options?.histogram ?? defaultHistogramBoundaries;
  const httpRequests = Metric.counter("dci_http_requests_total", {
    description: "Count of HTTP requests sent to the DCI API"
  });
  const httpFailures = Metric.counter("dci_http_request_failures_total", {
    description: "Count of failed HTTP requests"
  });
  const httpDurations = Metric.histogram("dci_http_request_duration_ms", {
    boundaries: histogramBoundaries,
    description: "DCI API request durations in milliseconds"
  });
  const paginationEvents = Metric.counter("dci_http_pagination_total", {
    description: "Count of pagination fetches performed for a request"
  });
  const cacheLookups = Metric.counter("dci_cache_lookups_total", {
    description: "Cache lookups performed by the DCI SDK"
  });
  const cacheHits = Metric.counter("dci_cache_hits_total", {
    description: "Cache hits served from memory or persistence"
  });
  const cacheMisses = Metric.counter("dci_cache_misses_total", {
    description: "Cache misses requiring data fetches"
  });
  const cachePopulates = Metric.counter("dci_cache_populates_total", {
    description: "Number of times cached namespaces were populated"
  });
  const inFlightGauge = Metric.gauge("dci_http_in_flight", {
    description: "In-flight HTTP requests"
  });
  let inFlight = 0;

  const adjustInFlight = (delta: number) =>
    Effect.sync(() => {
      inFlight = Math.max(0, inFlight + delta);
      return inFlight;
    }).pipe(Effect.flatMap((value) => Metric.update(inFlightGauge, value)));

  return {
    requestStart: (path) =>
      Metric.update(httpRequests, 1).pipe(
        Effect.andThen(adjustInFlight(1)),
        Effect.andThen(logAtLevel(level, "http.start", { path }))
      ),
    requestSuccess: (path, status, durationMs) =>
      Metric.update(httpDurations, durationMs).pipe(
        Effect.andThen(adjustInFlight(-1)),
        Effect.andThen(logAtLevel(level, "http.success", { path, status, durationMs }))
      ),
    requestFailure: (path, error, durationMs) =>
      Metric.update(httpFailures, 1).pipe(
        Effect.andThen(adjustInFlight(-1)),
        Effect.andThen(
          logAtLevel("info", "http.failure", {
            path,
            durationMs,
            error: error._tag,
            message: error.message
          })
        )
      ),
    pagination: (path, page, totalPages) =>
      Metric.update(paginationEvents, 1).pipe(
        Effect.andThen(logAtLevel(level, "pagination", { path, page, totalPages }))
      ),
    cacheLookup: (namespace, key) =>
      Metric.update(cacheLookups, 1).pipe(Effect.andThen(logAtLevel(level, "cache.lookup", { namespace, key }))),
    cachePopulate: (namespace, key) =>
      Metric.update(cachePopulates, 1).pipe(
        Effect.andThen(logAtLevel(level, "cache.populate", { namespace, key }))
      ),
    cacheHit: (namespace, key) =>
      Metric.update(cacheHits, 1).pipe(Effect.andThen(logAtLevel(level, "cache.hit", { namespace, key }))),
    cacheMiss: (namespace, key) =>
      Metric.update(cacheMisses, 1).pipe(Effect.andThen(logAtLevel(level, "cache.miss", { namespace, key })))
  };
};

export const DciObservabilityTelemetryLayer = (options?: TelemetryObservabilityOptions) =>
  Layer.succeed(DciObservability, makeTelemetryObservability(options));
