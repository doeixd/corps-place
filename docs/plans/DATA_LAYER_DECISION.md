# Data Layer Decision — Fate → TanStack DB (Effect-RPC custom collection)

**Decision:** retire the experimental **Fate** read layer and adopt **TanStack DB** as the
client data layer, fed by a **custom collection options creator backed by Effect RPC**.
Preload the small browseable *index* eagerly, **stream detail in after page load**, and keep
**Effect services as the single source of truth**. No ElectricSQL / Postgres.

Companion to `docs/plans/CLOUD_FLARE_DEPLOYMENT_PLAN.md` (edge site + VPS builder; D1/R2/KV)
and `docs/plans/READ_MODEL_PLAN.md` (the `rm_*` projection this serves).

---

## 1. Why move off Fate

- Fate is **alpha, single-maintainer, reads-only**, and per `AGENTS.md` its **full HTTP
  round-trip is unverified** in this app. It's an experimental side-path with **one
  reference route** (`app/routes/fate-events.tsx`) — not load-bearing. Cutting it is cheap.
- The primary path today is `loader → XState + useSearchSync`. That stays for SSR content.
- **TanStack DB** fits the existing stack (Start/Router/Query), covers **reads *and*
  optimistic mutations** (useful once auth/admin lands), and matches the local-first goal
  below. Trade-off: it's **0.6 beta** — we're swapping one pre-1.0 lib for a better-backed
  one, justified by ecosystem fit + the preload model, not by stability.
- Fate's masking *minimizes* per-component data; we want the **opposite** here — a
  **preloaded local dataset queried instantly** — which is TanStack DB's sweet spot.

> Keep `loader → selectors (effect/Predicate + Match)` for static SSR content pages.
> Reserve TanStack DB for interactive / cross-entity / mutation surfaces (directories with
> client-side filter/sort, prediction tables, future admin).

---

## 2. Client transport: plain `fetch` into TanStack DB (keep Effect off the client)

**Default: no Effect in the browser bundle.** The reads are **static JSON shards loaded
into TanStack DB** — that's plain `fetch`/`ReadableStream`, not Effect. Effect stays a
**server concern** (the VPS builder, the Worker request handlers, the emit). The client is
**TanStack DB + React**. This keeps the bundle smaller and the mental model simpler, and the
preload path (§3) needs nothing more.

```ts
// app/db/json-collection.ts — Effect-free; loads static shards into a collection
export function jsonIndexCollectionOptions<T>(opts: {
  id: string;
  getKey: (row: T) => string | number;
  url: string;                 // versioned shard URL (see §5 cache headers)
}) {
  return {
    id: opts.id,
    getKey: opts.getKey,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        let cancelled = false;
        (async () => {
          const rows: T[] = await fetch(opts.url).then((r) => r.json()); // or NDJSON stream
          if (cancelled) return;
          // chunk so we don't block the main thread on a big array
          for (let i = 0; i < rows.length; i += 500) {
            begin();
            for (const row of rows.slice(i, i + 500)) write({ type: "insert", value: row });
            commit();
            if (i === 0) markReady();   // usable after the first chunk
          }
        })();
        return () => { cancelled = true; };
      },
    },
  };
}
```

### When Effect on the client *would* earn its keep (optional, later)
Only if you adopt a **typed live `subscribe`** or **optimistic mutations** through
`@effect/rpc`. Even then, prefer plain SSE/`fetch` first; reach for an Effect-RPC custom
collection (below) only if the typed end-to-end client is worth the bundle cost. TanStack
DB collections are just a **collection options creator** wrapping a `sync` source, so the
Effect-RPC version is a drop-in alternative to the `fetch` version above — same shape, Effect
services still the source of truth (like Fate's "custom adapter over Effect, NOT direct DB").

`sync` gives `begin()` / `write()` / `commit()` / `markReady()` (+ cleanup return). Effect
RPC gives typed unary **and streaming** calls. Bridge them at the sync boundary — one of the
allowed `runFork`/`runPromise` boundaries (like Fate resolvers / XState actions).

```ts
// app/db/effect-rpc-collection.ts
export function effectRpcCollectionOptions<T>(opts: {
  id: string;
  getKey: (row: T) => string | number;
  load: () => Stream.Stream<ReadonlyArray<T>>;             // bulk, CHUNKED (see §3)
  subscribe?: () => Stream.Stream<{ type: "insert"|"update"|"delete"; row: T }>; // live (opt)
  onInsert?: (rows: T[]) => Effect.Effect<unknown>;        // writes → Effect RPC mutations
  onUpdate?: (rows: T[]) => Effect.Effect<unknown>;
  onDelete?: (keys: (string|number)[]) => Effect.Effect<unknown>;
}) { /* sync: chunked begin/write/commit + markReady-early; onInsert/Update/Delete via RPC */ }
```

- **`load`-only first** (refetch/query-style). Add `subscribe` later only where live updates
  pay off (prediction tables) — served on the edge by the **Durable Object** that replaces
  Fate-live SSE.
- Mutations route through the same RPC layer with optimistic UI + rollback for free — the
  thing Fate deliberately doesn't do.
- **You own the delta protocol** for `subscribe` (snapshot vs row deltas, ordering,
  reconnect/catch-up). Trivial for nightly-refreshed data; real work only for fine-grained
  live. Contained to this one adapter file.

---

## 3. Preload model: eager index, lazy detail, stream after paint

Measured read-model snapshot (`public/read-model/*.json`, emitted by `emitReadModel.ts`):

| Layer | Size | Strategy |
| --- | --- | --- |
| **Index/directory** — `events.json` + `corps.json` + `judges.json` (rows pages list/filter/sort) | **~1.5 MB raw / ~145 KB gzipped** | **Eager bulk preload** into TanStack DB. |
| **Detail shards** — per-event full recaps, per-corps/judge detail (125 + 243 + event shards) | **~41 MB** across hundreds of files | **Lazy / on-demand**, never bulk-shipped. |
| Relational DB | 2.5 GB | Never leaves the VPS. |

So "nearly the whole DB" = **the whole browseable index (~145 KB gz)** — ship all of it. The
43 MB is almost entirely detail to fetch on demand.

**Flow:**
1. **SSR the current route from the loader (D1)** → paint immediately. Never block first
   paint on the bulk load.
2. **After hydration, background-load the index collections** (one CDN-cached fetch each, or
   NDJSON). Live queries are incremental, so the UI fills progressively; `markReady()` after
   the first chunk, keep writing in batches (`Stream.grouped(500)` → begin/write/commit).
3. **Lazy-load detail shards** on navigation (or warm likely-next ones in idle time). Each
   shard is tiny and CDN-cached.
4. **Persist + version-gate.** TanStack DB 0.6 persistence (IndexedDB) → repeat visits skip
   re-download; check the **KV read-model version pointer** and refetch only when it changed
   (nightly). Seed the collection from the SSR payload where it overlaps the current route so
   rows aren't fetched twice.

```ts
sync: {
  sync: ({ begin, write, commit, markReady }) => {
    let first = true;
    Effect.runFork(
      streamIndexNdjson("/read-model/events").pipe(   // NDJSON/chunked from R2/CDN
        Stream.grouped(500),
        Stream.runForEach((batch) => Effect.sync(() => {
          begin();
          for (const row of batch) write({ type: "insert", value: row });
          commit();
          if (first) { markReady(); first = false; }  // usable after first chunk
        }))
      )
    );
    return cleanup;
  },
}
```

---

## 4. Where data comes from (ties into the edge plan)

- **Bulk snapshot → R2 / CDN static shards.** Already emitted as `public/read-model/*.json`
  — content-addressed, gzip-able, cache-forever. **Do not** bulk-export through D1 (per-query
  result-size limits; wasteful).
- **Targeted / live queries → D1** (via the `ReadModelDb` Effect service / Worker).
- **Version pointer / cache-busting → KV.**
- **Live deltas → streaming Effect RPC, served by a Durable Object** (only where needed).

| Concern | Backend |
| --- | --- |
| Bulk index + detail shards | R2 / CDN static JSON |
| Per-view / targeted reads | D1 |
| Read-model version (cache bust) | KV |
| Live deltas (optional) | Effect RPC stream → Durable Object |

### Cache headers (must fix — today they're wrong)

Today the shards are emitted as **static `public/read-model/*.json` with no `Cache-Control`
and non-hashed names** (`events.json`, `corps/<slug>.json`). That's a stable URL whose
content changes nightly — you can't cache it long without serving stale data. Fix with the
standard **immutable-versioned-shards + tiny revalidated manifest**:

1. **Version the shard URLs** so each build is a *new, immutable* URL. Either content-hash
   filenames in the emit (`events-<hash>.json`) and list them in a manifest, **or** append
   `?v=<version>` (the `meta.json` `built_at`, or better a content hash / the KV pointer).
   Serve these with:
   ```
   Cache-Control: public, max-age=31536000, immutable
   ```
   They never go stale because a new build = a new URL.
2. **The entry point is the only revalidated request.** `meta.json` (or a `manifest.json`
   mapping logical name → versioned URL) is short-cached + revalidated:
   ```
   Cache-Control: public, max-age=60, stale-while-revalidate=86400
   ETag: "<version>"
   ```
   The client fetches the manifest first (cheap, 304s most of the time), reads the version,
   then loads the **immutable** shards — cached forever after first download.
3. **Where to set them:**
   - **Edge (R2/CDN):** set `httpMetadata.cacheControl` on each R2 object at publish time
     (the emit's `--target r2` step), or a Cloudflare **Cache Rule** by path. Add a
     `Vary: Accept-Encoding` and pre-gzip/brotli.
   - **Current Node server:** set headers in `proxy.mjs` (or a small static-serve middleware)
     for `/read-model/*` — immutable for versioned shards, short+revalidate for the manifest.
4. **Client cache-bust = the version, not a timestamp.** Key IndexedDB persistence (§3) to
   the manifest version so a nightly emit invalidates exactly once; unchanged version → serve
   from IndexedDB with no network.

> Net: one tiny revalidated request per visit (the manifest); everything else is
> `immutable` and free after first load — the right shape for a nightly-rebuilt dataset.

---

## 5. Caveats

- **Memory & live-query cost, not transfer, is the ceiling.** ~145 KB gz index is fine; the
  differential-dataflow engine keeps in-memory indexes per live query, so bulk-loading the
  41 MB detail would hurt on mobile. **Preload the index; lazy the rest.**
- **Watch index growth.** `events.json` is 1.4 MB raw across all seasons today; if it grows
  several×, shard by season (preload current season eagerly, others on demand).
- **Two betas.** TanStack DB 0.6 + the custom creator — budget for pre-1.0 API churn.
- **Don't double-fetch** the SSR'd route's rows and the bulk index — seed from SSR payload.

---

## 6. Migration steps

1. **Remove Fate** (cheap, de-clutters): delete `app/fate/`, the `react-fate/vite` plugin
   wiring, the `<FateProvider>` in `__root.tsx`, `app/routes/fate-events.tsx` + the
   `api/fate*` routes, and the Fate section of `AGENTS.md`. (Keep the Effect services it
   wrapped — they're reused.)
2. **Versioned emit + cache headers** (§4): content-hash (or `?v=`) the shard filenames,
   emit a `manifest.json`, and set `immutable` headers on shards + short-revalidate on the
   manifest (in `proxy.mjs` now, R2 metadata / Cache Rule on the edge).
3. **`jsonIndexCollectionOptions`** (`app/db/json-collection.ts`) — Effect-free, plain
   `fetch` (or NDJSON), chunked sync + `markReady`-early.
4. **Index collections** (`events` / `corps` / `judges`) preloaded after paint from the
   manifest's versioned shard URLs; convert one directory page (e.g. events) to
   `useLiveQuery` as the reference consumer.
5. **Lazy detail** loaders for per-entity shards on navigation.
6. **Persistence + version-gate** (key IndexedDB to the manifest version); seed from SSR
   payload.
7. **(Later, optional, Effect on client)** `subscribe` streaming for prediction tables (edge
   Durable Object) and optimistic mutations (`onInsert/Update/Delete` → RPC) once auth/admin
   lands — only if a typed end-to-end client justifies the bundle cost.

After step 3, directory pages do client-side filter/sort with zero round-trips; the rest is
incremental.

---

## 7. Open decisions

1. **Versioning scheme:** content-hashed filenames (`events-<hash>.json` + manifest) vs.
   `?v=<version>` query (simpler, reuses current names). Hashed is cleanest for `immutable`;
   `?v=` is a smaller emit change. Pick one — both enable forever-caching.
2. **Index transport:** plain per-file JSON fetch (simplest, reuses existing shards) vs.
   NDJSON streaming endpoint (smoother progressive fill). Start with JSON, add NDJSON if the
   fill feels janky.
3. **How much to preload:** index-only (recommended) vs. index + current-season recaps.
4. **Effect on the client:** keep it **off** for reads (default). Only revisit if typed live
   `subscribe`/mutations land and a plain SSE/`fetch` won't do (§2).
5. **Persistence keying** to the manifest version — confirm the cache-bust story before
   relying on IndexedDB across nightly emits.

---

## 8. Implementation status (2026-06-12, branch `feat/tanstack-db-data-layer`)

**Done (steps 2–6):**
- **Versioning:** chose `?v=<content-hash>` per index shard (decision §7.1). `emitReadModel.ts`
  writes `manifest.json` (the one revalidated entry point) mapping each index collection to a
  hashed `?v=` URL + a global `version` token for on-demand detail shards.
- **Cache headers:** `proxy.mjs` serves `/read-model/*?v=` immutable, `manifest.json`/`meta.json`
  short max-age + SWR. `public/sw.js` CacheFirst for `?v=` shards (+ prunes superseded versions).
- **Client:** `@tanstack/react-db` + `app/db/{read-model-manifest,json-collection,collections,detail-shard}.ts`.
  Events directory reads `useLiveQuery(eventsCollection)` w/ SSR-loader fallback. Judge + corps
  detail load their shards on client nav (`loadDetailOrServer`), SSR uses the server fns.
- **Parity invariant enforced:** index shards (events/corps/judges) and detail shards
  (corps detail/scores/appearances, judge) are emitted through the SAME `readers.ts` the
  services use — verified byte-parity. (An earlier raw-`SELECT` emit drifted from the loader
  shape and was fixed.)

**Corrections to this doc:**
- `@tanstack/react-db` installed is **0.1.86**, not "0.6 beta". 0.1.86 has only
  `localStorageCollectionOptions` — **no IndexedDB persistence** (§3/§5/§7.5 assume it exists).
  Durable offline is therefore the **service worker's** job (already built: NetworkFirst docs /
  CacheFirst assets / SWR+prune data), not TanStack DB persistence. The collection re-syncs from
  SW-cached shards on reload. Revisit only if a future TanStack DB version ships IDB persistence.
- The served public dir is repo-root `public/`, not `app/public/`.

**Prediction page (past seasons) — DONE.** `readPredictionPageData` (readers.ts) is a shared
composer mirroring the past-season branch of `getHybridEventPredictionPageData`, composing the
same readers the services delegate to (so it can't drift). The emitter freezes it into
`prediction-page/<season>/<slug>.json` (= `{...PredictionPageData, fullRecap}`) for each
reachable `(season, slug)` — both `event.slug` and `competition_slug`, since links use either;
empty-resolving slugs are skipped. The route loads the shard on client nav (`loadDetailOrServer`),
SSR + 2026 keep the server fns. **2026 is deliberately excluded — its prediction reads the big
DB and stays live-regenerable.** The server fn's past-season branch carries a "keep in lockstep"
comment pointing at the composer (the one coupling not enforced by `verifyReadModel.ts`).

**Remaining / follow-ups:**
- Recap shards (`recaps/<comp>.json`) are emitted + parity-correct but unconsumed by any route,
  and keyed by `competition_slug` only (recaps matched via the `event_slug` fallback have no
  standalone shard). The past-season prediction page now serves recap data via the composite
  shard, so the standalone recap shards are currently dead weight — wire or drop later.
- Step 1 (remove Fate) — deprioritized. Step 7 (subscribe/mutations) — future, needs auth.
