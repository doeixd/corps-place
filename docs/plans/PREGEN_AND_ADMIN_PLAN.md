# Plan: Pre-generated predictions + Admin dashboard

Status: **proposed / handoff** — written for a fresh agent with no prior context.
Read **AGENTS.md** first (conventions are mandatory), then **DEPLOY-legacy-exe.dev.md** §9 (why this
exists) and **sdk/CORPS_SCRAPING_PLAN.md** (scrape/ingest pipeline).

This plan has two independent parts; do **Part A first** (it's small and unblocks a clean
prod deploy), then **Part B** (the admin dashboard, which reuses Part A's pieces).

---

## Orientation — what exists today (read before coding)

**Prediction flow (the thing Part A changes):**

- Route: `app/routes/events/$yearSlug/$slug/prediction.tsx`. Loader calls
  `getCachedHybridPrediction` (cache-only — returns `null` if not cached, never generates).
- If `null`, the client `predictionMachine` (`app/machines/prediction-machine.ts`) fires
  `LOAD_PREDICTION` → `getHybridPrediction` → `EventPredictionService.getOrCreate2026EventPrediction`
  (`app/lib/event-prediction-api.ts`) which **spawns `npx tsx scripts/predictEventRecap.ts --save-db`**
  to generate on demand, then reads it back. (We already hardened this against a
  save-but-exit-nonzero race — keep that behavior.)
- Generated rows live in `model_event_prediction_runs` / `model_event_prediction_rows`.
- Freshness: `currentPredictionInputSignature` + `isCachedPredictionFresh` decide whether a
  cached prediction is stale (input signature includes lineup, model fingerprint, mode,
  percent_through, judge assignments, builder version).
- Server fns in `app/lib/server-fns/hybrid.ts`: `getCachedHybridPrediction` (POST, cache-only),
  `getHybridPrediction` (POST, generate-or-create).

**Background-job pattern that ALREADY exists (reuse it for Part B):**

- `EventDirectoryService` (`app/lib/event-directory.ts`): `start2026Refresh` spawns a
  detached child (`spawnRefreshInBackground` → `seasonUpdateWorkflow`-style refresh) and
  records progress in the **`event_directory_refresh_runs`** table
  (`refresh_id, season, status('running'|'success'|'failed'), started_at, finished_at,
event_count, stdout, stderr, error_message`), with `appendRefreshRunOutput` streaming
  child stdout/stderr. `latest2026Refresh` / `get2026Refresh` read status. Server fns:
  `getHybridRefreshStatus`, `startHybridRefresh`.
- **This is the template** for "trigger a long job from the UI + poll its status." Part B
  generalizes it from one job type (season refresh) to several.

**SDK scripts the dashboard/cron drive (all `npx tsx scripts/…` in `sdk/`):**
`seasonUpdateWorkflow.ts` (the orchestrator: ingest → corps scrape → backfills → recaps →
ML rebuild → `--fine-tune` → predictions; flags `--season`, `--fine-tune`, `--model-dir`,
`--skip-corps`, `--dry-run`), `scrapeCorps.ts` (`--apply`/`--refresh`/`--slug`),
`scrapeEventPages.ts`, `scrapeWebsiteRecaps.ts`, `ingestLineupsFromScrapes.ts`,
`predictEventRecap.ts` (`--event <slug> --season 2026 --save-db [--force-refresh]`),
`trainModelV9Subcaption-fixed.ts` (fine-tune).

**Conventions (from AGENTS.md — follow exactly):** Effect Services + `Effect.fn`; thin
`createServerFn`; XState v5 for UI state; `effect/Match` + `effect/Predicate` for logic;
ReUI/shadcn components; `<Show>`/`<For>`; Motion; data-fetch in route loaders;
`useSearchSync` for URL state. Type-check: `npm run check` (app/) and `cd sdk && npx tsc
--noEmit -p tsconfig.json` (has pre-existing errors — diff vs baseline).

---

## Part A — Pre-generated predictions, web reads-only

**Goal:** the live web server **never spawns tfjs** on the request path. The nightly job
pre-generates predictions for relevant events; the web only reads cached rows. Keep
on-demand generation as a **dev-only fallback**.

### A1. Batch pre-generation

- Add `sdk/scripts/generateUpcomingPredictions.ts` (or extend `seasonUpdateWorkflow`):
  - Select 2026 events that (a) have a lineup, and (b) are upcoming or within a lookahead
    window (reuse the schedule window logic already in `seasonUpdateWorkflow`).
  - For each, regenerate **only if stale** — reuse `currentPredictionInputSignature` /
    `isCachedPredictionFresh` so unchanged inputs are skipped (cheap no-op nightly).
  - After a fine-tune the model fingerprint changes → all signatures go stale → it
    regenerates everything once. That's intended.
  - Concurrency 1 (avoid SQLite write contention — we saw that cause exit-1s); log a
    summary (generated / skipped-fresh / failed).
- Wire it into `seasonUpdateWorkflow` as the final step (after ingest/fine-tune), and make
  it runnable standalone (the admin "Regenerate predictions" trigger calls it).

### A2. Gate request-path generation

- Add env flag, e.g. `PREDICTIONS_READ_ONLY=true` (default true in prod; the runbook sets it).
- In `getHybridPrediction` / `getOrCreate2026EventPrediction`: when read-only, **do not
  spawn** — return the cached prediction or a `null`/"pending" result. Only spawn when the
  flag is off (local dev).
- Make the UI graceful when there's no cached prediction in read-only mode: the
  `predictionMachine` / route should show a "prediction not generated yet — check back
  after the nightly run" state instead of an error or an infinite spinner. (Today the
  machine fires `LOAD_PREDICTION`; in read-only mode that resolves to "no prediction".)

### A3. Acceptance criteria

- With `PREDICTIONS_READ_ONLY=true`, loading an uncached event's prediction page **spawns
  no child process** (verify: no `tsx`/`node` child during the request) and shows a clean
  "not yet generated" state.
- Running the nightly job populates predictions for all upcoming-with-lineup events;
  re-running immediately regenerates **0** (all fresh).
- Local dev (`PREDICTIONS_READ_ONLY` unset/false) still generates on demand as today.

---

## Part B — Admin dashboard

**Goal:** a protected `/admin` page to **see status** and **manually trigger** the same
jobs the cron runs. Reuses the `event_directory_refresh_runs` background-job pattern,
generalized.

### B0. Auth (prerequisite — keep simple)

- Better Auth is deferred (per MIGRATION_PLAN). For v1, gate `/admin` (and all admin server
  fns) behind a shared secret: `ADMIN_TOKEN` env, checked server-side in the route
  `beforeLoad`/loader and in **every** admin server fn (not just the UI). exe.dev's
  private-proxy can't protect a single path (it's per-VM), so the gate must be in-app.
  Document `ADMIN_TOKEN` in DEPLOY-legacy-exe.dev.md. (Swap for Better Auth later.)

### B1. Generalized job runner (Effect Service + table)

- New table `admin_jobs` (or generalize `event_directory_refresh_runs`):
  `job_id, kind('season_update'|'scrape_corps'|'scrape_event_pages'|'scrape_recaps'|
'ingest_lineups'|'generate_predictions'|'regenerate_event'|'fine_tune'),
args_json, status('running'|'success'|'failed'), started_at, finished_at, exit_code,
stdout, stderr, error_message`. (Mirror the existing refresh-runs columns + `kind`/`args`.)
- New `AdminJobsService` (Effect Service, `app/lib/admin-jobs.ts`) that:
  - `startJob(kind, args)`: spawns the corresponding `npx tsx scripts/…` **detached**, writes
    a `running` row, streams stdout/stderr into it (copy `spawnRefreshInBackground` /
    `appendRefreshRunOutput` from `event-directory.ts`), finalizes status on exit.
  - `latestJobs(kind?)`, `getJob(id)` for status reads.
  - **One running job per kind** (guard with `effect/Predicate` — reject if a job of that
    kind is already `running`, to avoid SQLite contention / duplicate trains).
- Map `kind → command` in one place (Match on kind → argv).

### B2. Server fns (thin, token-guarded) — `app/lib/server-fns/admin.ts`

- `adminStatus()` → dashboard snapshot (see B4 data).
- `adminStartJob({ kind, args })` → `AdminJobsService.startJob`.
- `adminJob({ id })` → status + tail of stdout for polling.
- Every handler validates `ADMIN_TOKEN` first.

### B3. Dashboard UI (`app/routes/admin/index.tsx`)

- XState machine `app/machines/admin-machine.ts`: context = status snapshot + running jobs;
  events `REFRESH_STATUS`, `START_JOB`, `POLL_JOB`; actions delegate to the admin server fns
  (per AGENTS.md, no logic in the component). Poll running jobs on an interval (machine
  `after`/invoked actor).
- Render with ReUI: `Card`s per section, `StatusPill`/`Badge` for job state (`effect/Match`
  on status → variant), `Button`s to trigger, `Table`/`DataGrid` for recent job history +
  live stdout tail. Confirm destructive actions (e.g. "regenerate ALL predictions",
  "fine-tune") via the existing confirm pattern.

### B4. What to show (status)

- **Data freshness:** latest `corps_page_scrapes.scraped_at` (directory + profiles),
  latest `event_page_scrapes`, latest `website_recaps`, latest `event_directory_refresh_runs`.
- **Prediction coverage:** for upcoming 2026 events — has a prediction? is it fresh
  (`isCachedPredictionFresh`)? last `predicted_at`. A table of "events needing prediction".
- **Model:** latest model dir under `sdk/models/v9_subcaption_fixed/` + its metadata
  (read `metadata.json`/`model-card.json` if present); last fine-tune job.
- **DB:** key row counts (events, corps, lineup entries, predictions) + DB file size.
- **Jobs:** recent `admin_jobs` with status/exit/duration + live tail of the running one.

### B5. Triggers (buttons → `adminStartJob`)

- **Run nightly workflow** (`seasonUpdateWorkflow --season 2026 [--fine-tune]`).
- **Scrape corps** (`scrapeCorps --apply [--refresh]`).
- **Scrape event pages** / **Scrape recaps** / **Ingest lineups**.
- **Regenerate predictions** (the Part A batch script) — and **regenerate one event**
  (`predictEventRecap --event <slug> --force-refresh`), with an event picker.
- **Fine-tune** (`trainModelV9Subcaption-fixed --load-model latest …`) — long job; surface
  progress via the stdout tail; guard against concurrent trains.
- **Re-fetch a single page** (event/corps/recap) for debugging a stale/broken scrape.

### B6. Acceptance criteria

- `/admin` is inaccessible without `ADMIN_TOKEN` (route **and** server fns reject).
- Each trigger starts the right `npx tsx` job, shows it `running`, streams stdout, and
  flips to `success`/`failed` with exit code; a second trigger of the same kind while one
  runs is rejected.
- Status panels reflect real DB/file state and refresh (poll) without a full reload.
- Triggering "Run nightly workflow" from the dashboard is equivalent to the cron run.

---

## Risks / notes

- **SQLite write contention:** never run two writers at once (cron vs admin trigger, or two
  trains). The per-kind "one running job" guard + concurrency-1 batch generation handle
  this; consider a global "is any write-heavy job running?" check before allowing another.
- **Long jobs vs the 2-vCPU box:** a fine-tune pegs CPU ~20–45 min and the web shares the
  box — fine off-peak, but the dashboard should warn before kicking a train during the day.
- **Detached spawns survive page navigation** (they're OS processes tracked in the table,
  not tied to the request) — that's the point; status is read from the table.
- **tfjs/Node 20:** jobs spawn `npx tsx` in `sdk/` (Node 20); the web can run newer Node.
  Keep using the existing `sdkChildEnv()` / spawn pattern.

## Suggested order

1. A1 batch script → A2 read-only gate → A3 verify. (Unblocks prod deploy.)
2. B0 auth gate → B1 jobs service + table → B2 server fns → B3/B4 status UI → B5 triggers.
3. Update DEPLOY-legacy-exe.dev.md: set `PREDICTIONS_READ_ONLY=true` and `ADMIN_TOKEN`; note the dashboard
   can run the nightly workflow manually.
