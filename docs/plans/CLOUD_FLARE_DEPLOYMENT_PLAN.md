# Cloudflare Deployment Plan — drumcorps.app (edge site + VPS builder)

**Goal: nothing runs on a personal computer.** The public site runs entirely on Cloudflare
(Pages/Workers, D1, R2, KV, Durable Objects, Cron, Queues). The heavy ML + ingest pipeline
runs on a small **VPS** — manually retrained, or behind a thin predict/retrain API — and
**publishes** artifacts up to Cloudflare. Browserbase stays the only other external
dependency (Cloudflare-bypass scraping; outbound API).

Companion to `DEPLOY-legacy-exe.dev.md` (the old local-tunnel runbook — superseded by this) and
`docs/plans/READ_MODEL_PLAN.md` (the read-model this design serves from the edge).

> **Decision (locked):** model **training/inference does not run on Cloudflare.** It runs
> on a VPS (or is retrained manually) because `tfjs-node` is native, the fine-tune peaks
> ~4.8 GB RAM, and the source DB is 2.5 GB — all of which a VPS with persistent disk
> handles trivially and Workers/Containers handle poorly. Cloudflare serves the
> **read-only** site from the precomputed read-model.

---

## 1. Target architecture

```
                          ┌──────────────────── PUBLIC (Cloudflare edge, always on) ────────────────────┐
  browser ─► Cloudflare ─►  Worker / Pages  (TanStack Start SSR, CF preset)
                              │   reads only — no tfjs, no sharp, no big DB
                              ├── D1  ............ read-model rm_* tables (the serving DB)
                              ├── R2  ............ media bytes + pre-resized variants  (MediaStorage svc)
                              ├── KV  ............ hot pointers/flags: active read-model version, config
                              ├── Durable Object . read-model version flip + Fate-live/SSE fan-out
                              └── Queue (opt) .... media fetch-on-miss
                          └─────────────────────────────────────────────────────────────────────────────┘
                                        ▲ publish (outbound only): D1 import · R2 put · KV flip
                                        │
                          ┌──────────── VPS builder (not a personal computer) ───────────────┐
                          │  cron (or manual / on-demand API trigger)                          │
                          │   scrape → ingest → [train] → predict → emit → publish             │
                          │  persistent disk:                                                  │
                          │    • dci-relational.db (2.5 GB)  ← source of truth, lives here      │
                          │    • models/<run>/                                                  │
                          │  Browserbase (outbound) ── scrapes Cloudflare-protected DCI pages   │
                          └────────────────────────────────────────────────────────────────────┘
```

**Role per primitive:**

| Where | Role |
| --- | --- |
| **Workers / Pages** | TanStack Start SSR + static assets + all `/api/*` (Fate, `/api/media`). Read-only request path. |
| **D1** | The **serving database** — read-model (`rm_*`). Small, read-mostly, read-replicated. |
| **R2** | Media bytes + pre-resized variants; nightly **DB backup** snapshots; published model metadata if needed. Zero egress. |
| **KV** | Tiny hot keys: **active read-model version pointer**, feature flags, media ETags. |
| **Durable Objects** | The atomic read-model version flip; Fate-live/SSE fan-out. |
| **Cron Triggers** | (Optional) ping the VPS to start a run, and a show-day prediction refresh. |
| **Queues** | (Optional) media fetch-on-miss at the edge; resize jobs. |
| **VPS** | The one builder box: `sdk/` toolchain (`tfjs-node`, `sharp`, `cheerio`, `@libsql/client`, `tsx`), the **persistent 2.5 GB DB**, training/inference. Publishes to D1/R2/KV. **No inbound public traffic** (no tunnel) — outbound publish, plus an *optional* auth'd trigger endpoint. |

---

## 2. The split: edge reads vs. VPS writes

Rests on the invariant already true in prod (`DEPLOY-legacy-exe.dev.md §9`, `READ_MODEL_PLAN`): **the
request path only reads precomputed data.** Keep it absolute.

- **Edge (Workers) — reads only.** Never `tfjs`, never `sharp` on a request, never the big
  DB. Predictions are rows in `rm_event_prediction`; media is bytes in R2; pages are SSR'd
  from D1. Audit `app/` server code for Node-only APIs (`node:fs`, `child_process` — e.g.
  the on-demand `npx tsx` predict spawn in `app/lib/event-prediction-api.ts`) and **fence
  them out of the Worker build** (VPS/dev only).
- **VPS — writes only (to Cloudflare).** All heavy/native work: scrape, ingest, optional
  train, predict, emit the read-model. It then **publishes**: import `rm_*` → D1, put media
  → R2, flip the KV version pointer. The VPS is never on the request path and needs no
  public ingress.

This is the existing **builder/serve split** (shared `rm_*` builders in
`sdk/src/readModel/builders/*`) — we relocate the *builder* from a home PC to a VPS and the
*serving DB* from a local file to D1. The relational DB stays a SQLite **file on the VPS
disk** (persistent — no Container hydration needed).

### Two operating modes (pick one; easy to upgrade later)
- **A. Manual retrain (simplest).** You run the pipeline on the VPS (or locally) when scores
  drop, and it publishes. The site is always up on Cloudflare; data just refreshes when you
  run it. Lowest effort, no scheduler, no API.
- **B. VPS predict/retrain API + Cron (autonomous).** A small auth'd service on the VPS
  exposes `POST /run` (scrape→…→publish) and/or `POST /predict`; a **Cloudflare Cron**
  Worker calls it nightly/show-day. Still nothing on your computer, and refreshes happen on
  their own. Recommended once mode A is stable.

---

## 3. MediaStorage — an Effect service (R2 / KV behind one interface)

Replaces `app/lib/media-cache.ts` (`getOrFetchMedia`, `/api/media`) and
`sdk/src/mediaService.ts` (`MediaService`) — today both hit the shared `media-cache.db`.
One Effect service, swappable backends: **R2 primary** (bytes); KV optional for tiny/hot
variants; a tiered layer can check KV → R2. The VPS uses the same `R2MediaStorageLive`.

```ts
// app/lib/media/storage.ts
import { Effect, Schema, Layer } from "effect";

export class MediaNotFound extends Schema.TaggedError<MediaNotFound>()(
  "MediaNotFound", { key: Schema.String }) {}
export class MediaFetchError extends Schema.TaggedError<MediaFetchError>()(
  "MediaFetchError", { url: Schema.String, status: Schema.Number }) {}
export class MediaForbiddenHost extends Schema.TaggedError<MediaForbiddenHost>()(
  "MediaForbiddenHost", { host: Schema.String }) {}   // SSRF guard (keep the allowlist)

export interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly byteLength: number;
}

export class MediaStorage extends Effect.Service<MediaStorage>()("MediaStorage", {
  accessors: true,
  effect: Effect.succeed({
    get:  (key: string) => Effect.fn("MediaStorage.get")(/* ... */),
    put:  (key: string, m: StoredMedia) => Effect.fn("MediaStorage.put")(/* ... */),
    head: (key: string) => Effect.fn("MediaStorage.head")(/* ... */),
    // fetch-on-miss with SSRF allowlist + optional resize key; cache-by-default
    getOrFetch: (url: string, opts?: { width?: number }) =>
      Effect.fn("MediaStorage.getOrFetch")(/* ... */),
  }),
}) {}

// Backends as Layers — pick per environment:
export const R2MediaStorageLive    = Layer.effect(MediaStorage, /* env.MEDIA_BUCKET (R2) */);
export const KvMediaStorageLive    = Layer.effect(MediaStorage, /* env.MEDIA_KV (small/hot) */);
export const TieredMediaStorage    = /* KV head → R2 get; R2 = source of truth */;
export const SqliteMediaStorageLive = /* legacy media-cache.db — VPS/local fallback */;
```

- **Keys** content-stable: `sha/<hash>` for originals, `sha/<hash>@w<width>.webp` for
  variants — immutable, CDN-cacheable forever.
- **Resizing off the request path.** `sharp` runs on the **VPS** during the media publish
  step (or an edge resize Queue consumer), pre-generating common widths. The Worker's
  `/api/media` then only does an R2 lookup + `Cache-Control: immutable`. Unseen width →
  Cloudflare Image Resizing or an on-miss Queue job.
- **SSRF guard stays:** the host allowlist (a reused `Predicate`) on `getOrFetch`; blocked
  host → `MediaForbiddenHost`.
- **Cutover:** point the app + SDK `MediaService` at `R2MediaStorageLive`; one-time migrate
  `media-cache.db` BLOBs → R2 (stream rows → `bucket.put`); `media_assets` metadata → D1.

A parallel `ReadModelDb` Effect service abstracts the serving DB the same way: a **D1**
SqlClient layer at the edge, a **libsql `file:`** layer on the VPS — so
`app/lib/read-model-db.ts`'s `getReadModelClient` becomes "provide the right layer," not an
`if`.

---

## 4. Data lifecycle (where each artifact lives)

| Artifact | Source of truth | Served from | Notes |
| --- | --- | --- | --- |
| `dci-relational.db` (2.5 GB) | **VPS disk** | never served | Persistent; rebuildable from archives. Nightly `.backup` → R2. |
| Scrape archives (`*_page_scrapes`, `website_recaps`, `api_responses`) | **VPS disk** (in the DB) | never served | Durable "time travel". |
| Read-model (`rm_*`) | built on VPS | **D1** | The serving DB. Versioned + atomic KV-pointer flip. |
| Media bytes + variants | DCI / scrapes | **R2** (+ KV head) | via `MediaStorage`. Immutable keys, CDN-cached. |
| Model artifacts (`weights.bin`, `model.json`) | VPS training | **VPS disk** (latest + a few) | Loaded by the VPS predictor; the edge never touches them. |
| Active read-model version | flip step | **KV** + DO | Workers read it to pick the live D1 version. |
| DB backups | nightly | **R2** (lifecycle TTL) | The DB is the only not-cheaply-rebuildable asset. |

**Zero-downtime publish (the A/B flip, edge edition).** Today `emitReadModel.ts` writes the
inactive A/B file slot and flips `read-model.active`. Edge equivalent: the VPS imports the
new `rm_*` into D1 as a **new version** (versioned table set or a staging dataset), verifies
parity (`verifyReadModel.ts`), then a **Durable Object flips the KV pointer** atomically.
Workers read the pointer per request (cached) and see new data with no deploy — same
guarantee, no file-rename trick.

---

## 5. The builder pipeline (on the VPS)

```
cron on the VPS  (or: Cloudflare Cron → POST /run on the VPS, mode B)
  └─► seasonUpdateWorkflow (the existing script, +a publish step)
        scrape    (Browserbase outbound)
        ingest    (parse archives → relational DB on disk)
        [train]   (tfjs-node fine-tune — manual or scheduled; the heavy step)
        predict   (precompute rm_event_prediction for upcoming events)
        emit      (build rm_* → import to D1 as a new version)
        verify    (verifyReadModel parity)
        flip      (DO flips KV version pointer → site sees new data)
        media     (sharp pre-resize → R2; media_assets → D1)
        backup    (.backup → R2, lifecycle TTL)
```

- The pipeline is the current `seasonUpdateWorkflow` (`DEPLOY-legacy-exe.dev.md §8`) with the trailing
  **emit/publish** retargeted from local files to **D1 + R2 + KV** instead of the A/B file
  slots.
- **`[train]` is optional per run** — drop it for an inference-only refresh (mode A), keep it
  when you want a fresh model. This is the manual/automatic knob you chose.
- VPS sizing follows `DEPLOY-legacy-exe.dev.md §3`: **8 GB RAM** if it ever trains in-place (the ~4.8 GB
  peak + swap headroom), **2 vCPU / 4 GB** if it's inference-only and you train elsewhere.
  NVMe for the SQLite random reads over 2.5 GB. Node 20 (tfjs-node prebuilts; glibc, not
  Alpine).

---

## 6. Security & ops for the VPS

- **No public ingress.** The VPS serves nothing to browsers (Cloudflare does). It only needs
  **outbound** to D1/R2/KV (Cloudflare API tokens) + Browserbase. In mode B, the single
  inbound `POST /run` endpoint is **auth'd** (shared secret / mTLS) and ideally only callable
  from the Cloudflare Cron Worker (allowlist CF egress or a signed header).
- **Credentials:** scoped Cloudflare API token (D1 write + R2 write to the one bucket + KV
  write to the one namespace), `BROWSERBASE_API_KEY`, on the VPS only — never in the Worker.
- **Backups from day one:** nightly `.backup` of `dci-relational.db` → R2 (lifecycle-expired).
  It's the one un-rebuildable-cheaply asset (losing it loses scrapes + cached predictions).
- **Idempotent publish:** import to a new D1 version then flip, so a half-finished publish
  never serves partial data; a failed run leaves the previous version live.

---

## 7. Migration sequence (incremental, each step shippable)

1. **MediaStorage service + R2.** Build the Effect service (§3), migrate `media-cache.db`
   → R2, point `/api/media` + the SDK `MediaService` at `R2MediaStorageLive`, edge-cache
   variants. *(First state off the box; `sharp` leaves the request path.)*
2. **Read-model → D1.** Add the `ReadModelDb` D1 layer + a `--target d1` mode in
   `emitReadModel.ts`; import `rm_*` to D1; flip Workers to read D1 via a KV version pointer.
   *(Serving DB off the box.)*
3. **App on Workers/Pages.** Cloudflare preset; fence Node-only APIs out of the Worker build;
   verify SSR streaming + Fate-live (DO). Point `drumcorps.app` at the Worker. *(Public site
   fully edge — your computer serves nothing.)*
4. **Stand up the VPS builder.** Provision (Node 20, NVMe, 8 GB if training there), move
   `dci-relational.db` + latest model onto it, run the pipeline end-to-end, retarget the
   emit/publish to D1/R2/KV. *(Refresh leaves your computer.)*
5. **Automate (mode B, optional).** VPS cron *or* a Cloudflare Cron Worker → auth'd `POST
   /run`; add the DB backup + the show-day prediction refresh. *(Nightly refresh autonomous;
   nothing on your computer.)*
6. **Decommission local.** Retire `deploy.ps1` / `proxy.mjs` / the `cloudflared` tunnel and
   the local DB files; update `DEPLOY-legacy-exe.dev.md` to point here.

After step 3 the **public site no longer depends on your computer**; after step 4 (manual) /
step 5 (automatic) **nothing does**.

---

## 8a. The builder VPS — provisioned (exe.dev `corps-place-vm`)

The builder runs on an **exe.dev** VM (the `DEPLOY-legacy-exe.dev.md` provider). Already created and running.

- **Host / access:** `corps-place-vm.exe.xyz`. Shell: `ssh corps-place-vm.exe.xyz` (full
  SSH/scp/port-forward). Management lobby (no shell): `ssh exe.dev` (`ls`, `share set-public`,
  `share port`). Auth is the default `~/.ssh/id_ed25519` (already trusted; no password).
- **User:** `exedev` (uid 1000), **passwordless `sudo`**, in the `docker` group. *Not* root by
  default — prefix system changes with `sudo`.
- **Specs:** Ubuntu 24.04 / x86_64 (glibc → `tfjs-node` prebuilts OK), **2 vCPU**, **7.8 GB
  RAM**, `/dev/vda` ext4 **25 GB (20 GB free)**.
- **Done:** ✅ **4 GB swap added** (`/swapfile`, in `/etc/fstab`) — OOM insurance for the
  ~4.8 GB fine-tune peak.
- **Still needed to become the builder:** Node 20 + build-essential; `git clone` (repo is now
  ~180 MB); `npm ci` (root + `sdk/`); `scp` the 2.5 GB `dci-relational.db` + latest model up;
  the **publish** path (scoped Cloudflare API token for D1/R2/KV + `BROWSERBASE_API_KEY`).
- **⚠️ Disk is the binding constraint, not RAM.** 20 GB free holds the 2.5 GB DB fine, but
  scrape archives + a model dir per nightly run grow over a season (`DEPLOY-legacy-exe.dev.md §10`). Either
  prune archives / keep latest-N model (we already keep latest-N), or grow the disk
  (exe.dev pooled plan is 100 GB). **Check resize before loading the DB.**
- **Role note:** under this plan the VM is a **pure builder** — no inbound tunnel, no
  `proxy.mjs`, no `.output/server`. Outbound publish only (+ optional auth'd trigger
  endpoint for mode B). Less load than the old `DEPLOY-legacy-exe.dev.md` monolith.

## 8. Open decisions

1. **Training on the VPS, or manual/local then publish?** The VM (8 GB + 4 GB swap) *can*
   train in place (~20–45 min on 2 vCPU). Decide whether nightly training runs on it or you
   retrain manually and the VM only does ingest→predict→publish.
2. **Mode A (manual) vs. B (Cron + auth'd API)** to start. Recommend **A first**, upgrade to
   **B** once stable.
3. **D1 vs. Turso for the serving DB.** D1 = native to Workers, a bit more adapter work
   (`@effect/sql` D1 layer + `--target d1` emit). Turso = near drop-in for the existing
   `@libsql/client` (less code) but a non-CF dependency. All-Cloudflare → **D1** (assumed);
   confirm.
4. **Media: R2-only vs. tiered R2+KV.** Recommend **R2-only** to start; add KV if head
   latency matters. Which `/api/media` widths to pre-generate (rest → Image Resizing / Queue)?
5. **Plan/budget.** Workers Paid (+ optional Queues) is single-digit $/mo; the VPS is the
   main recurring cost (~$5–20/mo depending on RAM). Nothing to run on your machine.

---

## 9. Re-architecture: what actually changes (grounded in the current code)

Good news first: **this is not a rewrite.** The domain logic already lives in Effect
services, and the reads already funnel through a couple of chokepoints. The work
concentrates at **four boundaries**; everything else is compiled into one of two builds
(edge vs. VPS). The hard part isn't logic — it's **moving from module-global singletons on
`process.env` to per-request Cloudflare bindings**, which Effect Layers are built for.

### 9.1 The core shift: ambient singletons → Effect bindings (the pervasive one)
Today the DB/media clients are **module-global singletons** keyed off `process.env`:
- `app/lib/read-model-db.ts` → `let client` + `createClient({url:file:...})`, polling an
  A/B pointer with `node:fs`.
- `app/lib/media-cache.ts` → `sharedDb ??= createClient(...)` + `sharp` via runtime require.
- `app/lib/event-prediction-api.ts`, `server-fns/hybrid.ts` → more `createClient` singletons.

On Workers there is **no `process.env` and no module-global I/O** — D1/R2/KV arrive as
**per-request `env` bindings**. So these become a request-scoped Effect service:

```ts
// app/lib/cf/bindings.ts
export class CfBindings extends Effect.Service<CfBindings>()("CfBindings", {
  accessors: true,            // env.READ_MODEL (D1), env.MEDIA_BUCKET (R2), env.KV, ...
}) {}                          // provided per request from the Worker's `env`
```

TanStack Start's Worker handler exposes `env`; we wrap each request in a Layer that provides
`CfBindings`. The Node/VPS build provides the **same service** backed by libsql-file + the
local FS. **Because the call sites are already Effect** (`Effect.suspend(() =>
use(getReadModelClient()))` etc.), they change from "call a global" to "`yield*` a service"
— mechanical, and the logic is untouched.

### 9.2 `ReadModelDb` — one seam for libsql-file ↔ D1
Every read service already goes through **`getReadModelClient()` → `db.execute({sql, args})`**
(see `event-directory.ts`, `corps-directory.ts`, `judge-directory.ts`, `event-recap.ts`).
That single function is the seam:

```ts
export interface ReadModelDb { execute(q: {sql: string; args?: unknown[]}): Promise<{rows: Row[]}>; }
export const ReadModelDb: Context.Tag<...>           // libsql-file layer (VPS) | D1 layer (edge)
```

- **Queries are raw SQL strings** → they mostly port as-is (D1 is SQLite). The one real
  chore: **normalize result shape** — libsql returns `{rows}`, D1 returns `{results}` — and
  param binding (`?` positional works in both). Wrap D1 so `.execute()` returns `{rows}`.
- The whole **A/B-slot + `node:fs` pointer** machinery in `read-model-db.ts` **disappears at
  the edge** (D1 is a binding, not a file). The zero-downtime flip becomes "publish a new D1
  version + flip the **KV** pointer" (§4). The libsql-file layer keeps A/B for the VPS/local.
- Optional: do this via **`@effect/sql` SqlClient** (a D1 client layer) so the SDK and app
  share one query API — cleaner, but a bigger touch than the thin `.execute()` adapter.

### 9.3 `MediaStorage` — the Effect service from §3
`media-cache.ts` (sqlite + `sharp` + `node:module`) → the `MediaStorage` service with an **R2
layer** at the edge and a **sqlite/sharp layer** on the VPS. `sharp` resizing moves to the
VPS publish step (or an edge Image-Resizing/Queue path). `/api/media` becomes an R2 lookup.
The SSRF allowlist survives as a `Predicate`. This is the smallest, most self-contained
boundary — **do it first** (§7.1).

### 9.4 Build split + fencing the Node-only code
Two outputs from one repo:
- **Edge (Workers preset).** Switch TanStack Start from the Node `.output/server` preset to
  the **Cloudflare preset**. The Worker graph must **not import** the builder-only modules:
  `sdk-process.ts`, the `spawn`/`@sdk/src/training/*` half of `event-prediction-api.ts`,
  `sharp`. These are already isolated — replace the edge versions with **read-only** ones
  (`event-prediction-api` on the edge just reads `rm_event_prediction` from D1; no spawn, no
  model load). Enforce with a lint/`no-restricted-imports` rule so a `node:`/`tfjs`/`sharp`
  import can't leak into the Worker bundle.
- **VPS (Node preset, current build).** Keeps the full toolchain — unchanged. It gains a
  **publish target** in `emitReadModel.ts` (`--target d1|r2|kv`) instead of writing file
  slots.

### 9.5 SSR streaming + Fate-live on Workers
Verify two things actually stream on Workers (they're fine on Node today): **streaming SSR**
and **Fate-live SSE** (`app/routes/api/fate.live.ts`). On the edge, the live fan-out is a
natural **Durable Object** (one DO per topic), since Workers are stateless. Plain Fate
reads (`/api/fate`) are just D1-backed and need no DO.

### 9.6 The VPS API — yes, use Effect HTTP (`@effect/platform`)
For mode B (Cron-triggered `POST /run` / `/predict`), build it with **`@effect/platform`
`HttpApi`** — you already depend on `@effect/platform` + `@effect/rpc`, so it's idiomatic:
typed routes, `Schema`-validated payloads, and the handlers **reuse the existing Effect
services** (ingest, predict, emit) directly — no new business logic, just an HTTP surface +
auth middleware (shared-secret/mTLS) in front of `seasonUpdateWorkflow`. (`@effect/rpc` over
HTTP is an alternative if you want a typed client; `HttpApi` is simpler for a few endpoints.)

### 9.7 What does NOT change
- **Effect services / domain logic** (`app/lib/*`, `sdk/src/*`), XState machines, Fate views,
  predicates, `effect/Match` usage — all reused. We swap **Layers**, not logic.
- **The `rm_*` read-model shape** and the builders (`sdk/src/readModel/builders/*`) — the
  same projection feeds the VPS emit; only its *sink* changes (file → D1/R2/KV).
- **The SDK pipeline** (scrape/ingest/train/predict) — runs on the VPS as-is.

### 9.8 Effort shape (rough)
| Boundary | Surface | Risk |
| --- | --- | --- |
| MediaStorage → R2 | 1 module + `/api/media` + SDK `MediaService` + a BLOB→R2 migration | low |
| ReadModelDb → D1 | 1 seam (`getReadModelClient`) + result-shape adapter + D1 emit target | medium (dialect/result shape) |
| Bindings as Effect Layers | every `getDb()`/singleton call site, but mechanical | medium (pervasive, low logic) |
| Workers build + fencing | preset swap + edge-only read variants + import guard | medium (SSR/Fate-live verification) |
| VPS publish + HttpApi | emit `--target` + a small Effect HTTP service | low–medium |

The two-thirds that would be a rewrite in a non-Effect app — the domain logic — is exactly
the part we keep. The migration is **swap the Layers at the edges, fence the native code into
the VPS build.**
