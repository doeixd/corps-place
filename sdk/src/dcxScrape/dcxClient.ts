import { Context, Effect, Layer, Schedule } from "effect";

/**
 * Throttled, polite HTTP client for dcxmuseum.org.
 *
 * The site is a no-Cloudflare ColdFusion app, but robots.txt is `Disallow: /`
 * (volunteer archive) — so we scrape gently: a descriptive UA, per-request jitter,
 * and a global minimum spacing between requests (a mutex-serialized delay so even
 * with N worker fibers we never burst). Transient failures retry with backoff.
 */

export class DcxFetchError extends Error {
  readonly _tag = "DcxFetchError";
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

const DEFAULT_UA =
  "dcx-archive-mirror/1.0 (+https://drumcorps.app; contact ithepatrickglenni@gmail.com)";

// Minimum spacing between any two requests (ms). With ≤2 workers this keeps us
// well under one request every ~400ms.
const MIN_SPACING_MS = 400;
const JITTER_MS = 200;

export interface DcxClientOptions {
  readonly userAgent?: string;
  readonly minSpacingMs?: number;
}

export interface DcxClientShape {
  readonly fetchText: (
    url: string,
  ) => Effect.Effect<{ readonly html: string; readonly httpStatus: number }, DcxFetchError>;
}

const makeClient = (opts?: DcxClientOptions): Effect.Effect<DcxClientShape> =>
  Effect.gen(function* () {
    const ua = opts?.userAgent ?? DEFAULT_UA;
    const minSpacing = opts?.minSpacingMs ?? MIN_SPACING_MS;

    // Serialize the *pacing gate* across all fibers: each request waits until at
    // least `minSpacing` has elapsed since the previous one started. A plain
    // mutable timestamp guarded by Effect's cooperative scheduling is enough
    // here (single Node process); we add jitter to avoid lockstep.
    let nextAllowedAt = 0;

    const pace = Effect.sync(() => {
      const t = Date.now();
      const wait = Math.max(0, nextAllowedAt - t);
      const jitter = Math.floor(Math.random() * JITTER_MS);
      nextAllowedAt = Math.max(t, nextAllowedAt) + minSpacing + jitter;
      return wait + jitter;
    }).pipe(Effect.flatMap((ms) => Effect.sleep(`${ms} millis`)));

    const fetchText = (url: string) =>
      Effect.gen(function* () {
        yield* pace;
        const res = yield* Effect.tryPromise({
          try: (signal) => fetch(url, { headers: { "User-Agent": ua }, signal }),
          catch: (e) => new DcxFetchError(`network error for ${url}: ${String(e)}`),
        });
        if (!res.ok) {
          // 4xx (except 429) is terminal-ish but we surface status so the handler
          // can decide; the queue's retry cap stops infinite loops.
          return yield* Effect.fail(
            new DcxFetchError(`HTTP ${res.status} for ${url}`, res.status),
          );
        }
        const body = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (e) => new DcxFetchError(`read body failed for ${url}: ${String(e)}`),
        });
        return { html: body, httpStatus: res.status };
      }).pipe(
        // Retry transient errors (network + 5xx + 429) with exponential backoff.
        Effect.retry({
          schedule: Schedule.exponential("500 millis").pipe(Schedule.both(Schedule.recurs(4))),
          while: (e: DcxFetchError) =>
            e.httpStatus === undefined || e.httpStatus === 429 || e.httpStatus >= 500,
        }),
      );

    return { fetchText };
  });

export class DcxClient extends Context.Service<DcxClient, DcxClientShape>()("DcxClient") {}

export const DcxClientLive = Layer.effect(DcxClient, makeClient());

export const makeDcxClientLayer = (opts: DcxClientOptions) =>
  Layer.effect(DcxClient, makeClient(opts));
