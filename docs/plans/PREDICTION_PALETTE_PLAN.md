# Prediction Palette — a full what-if scenario page

Status: **DRAFT for review** — not started. Written so a fresh agent can build it.

## 0. TL;DR / Goal

A standalone page, **`/predict/palette`**, where anyone can **turn every knob** behind a DCI prediction and watch the projected ranking + scores recompute — then **share the exact scenario via the URL**. Knobs span the cheap (nudge a corps's score, likelihood window, Monte-Carlo roll — recomputed instantly in the browser) and the deep (swap the **event**, edit the **lineup**, change the **judge panel**, move **season progress / baselines** — which **re-run the model** server-side). Corps render with their **canonical identity, colors, and logos**. **All state lives in the URL.**

This is a real feature with a real dependency: the prediction core must be made **parameterizable** (today it reads lineup/judges/data from the DB). And because re-running the model is heavy on the 4 GB box (we OOM'd it on 2026-06-28 running a 75-event batch), the server path must be **capped, debounced, and cached** — see §6.

## 1. Grounding — verified 2026-06-28

**Engine (client-side, pure):** `app/lib/prediction-scenario.ts` — `rollScenario(seed)` (Monte-Carlo sample), `SCENARIO_WINDOWS` 0.5/0.8/0.95 likelihood, `computedRanges(row, window)`, `computeRankRanges`, sort cycling, `RangeKey`/`SortMode`.

**Data already on the client:** `rm_event_prediction.summary_json.recap: RecapRow[]` — per corps: `corps_key`, `corps`, `division`, `total`, GE/Visual/Music, the 8 captions, **`caption_intervals`** (confidence bands), `predicted_score_breakdown`, `percent_through`, `mode`, baseline/prior fields. So the cheap knobs need **no server call**.

**Prediction generator (`sdk/scripts/predictEventRecap.ts` → `sdk/src/prediction.ts` + `src/mlService.ts` + `src/training/v9PredictionFeatures.ts`):** the pipeline is now repaired and runs (Node-20 via `vp exec`, tfjs pure-JS — see `predictions-pipeline` memory). Overridable today: **`--percent-through`**, **`--mode`** (`auto|as_of_show_date|preseason_forecast|panel_unknown|lineup_unknown`), `--division`, `--model-dir`. **NOT overridable today:** custom **judge panel**, custom **lineup** (add/remove corps), **baseline/data** swaps — these are read from the DB (`event_lineup_entries`, judge assignments, scores). **This is the main build dependency** (§4).

**Corps identity + brand:** canonical corps after the dedupe work (`corps-key-duplication`, `dca-division-label-split` memories). Colors/logos via the corps-color system (`corpsPalette`, `logo-recolor.ts`, `app/lib/vs/colors.ts`) — reuse it so each row shows the right logo + accent.

**Precedent:** the per-event `prediction.tsx` already does URL-driven `seed`/`win`/sort via a search codec — copy that pattern at larger scale.

## 2. Two compute tiers

| Tier | Knobs | How | Latency |
|---|---|---|---|
| **A — client, instant** | per-corps/caption nudge, likelihood window, Monte-Carlo roll, sort/group, division relabel | transform the loaded `RecapRow[]` in the browser (`applyLevers` + the engine) | <16 ms |
| **B — server, re-run model** | event slug, **lineup** (add/remove/swap corps), **judge panel**, **baselines / season-progress / mode** | `runScenarioPrediction(overrides)` → parameterized predict → returns a fresh `RecapRow[]` (no DB save) | seconds (cached) |

Tier A is the default interaction; Tier B fires only when a model-input knob changes (debounced), shows a "recomputing…" state, and **caches by a hash of the inputs** so a shared link or a repeated scenario is instant.

## 3. The knobs (full inventory)

- **Event** — pick any event with data; loads its base forecast (Tier B fetch, cached).
- **Lineup** — add a corps (from the season's corps), remove one, or swap; re-predict (B).
- **Judge panel** — choose judges per caption (or "panel unknown"); re-predict (B). (`--mode panel_unknown` exists; explicit panels need parameterization.)
- **Season progress / baselines** — `percent_through` slider (B, already a flag); baseline/prior-season comparable weighting (B, needs param).
- **Per-corps nudge** — ± total (v1) and ± per-caption (v2); re-rank (A).
- **Likelihood window** — 50/80/95% bands (A).
- **Monte-Carlo roll** — seeded re-sample (A).
- **Display** — sort, group-by-class, ranges on/off, show deltas vs. base (A).

## 4. The core dependency — parameterize the predictor (the hard part)

Refactor so the model can predict from **explicit inputs** instead of only DB reads:

- In `sdk/src/prediction.ts` (+ `v9PredictionFeatures.ts`), extract a `predictFromInputs({ corps, lineup, judgePanel, percentThrough, baselines, mode, modelDir })` that builds features from the **passed** lineup/judges/baselines rather than querying. The existing DB path becomes a thin caller that assembles those inputs from the DB, then calls the same core. **Risk: the feature builder may be tightly coupled to DB queries — scope a spike first.**
- Add `sdk/scripts/scenarioPredict.ts` (or extend predictEventRecap with `--scenario-json <inputs>`) that runs the core with overrides and prints the forecast JSON, **without `--save-db`** (scenarios never write to the DB).

If parameterization proves too invasive for v1, **degrade gracefully**: ship Tier A (all client knobs) + the already-supported server knobs (`percent_through`, `mode`), and gate lineup/judge editing behind a follow-up once the predictor is parameterized.

## 5. Server surface + caching

- **Server-fn `runScenarioPrediction(overrides)`** (new, `app/lib/server-fns/scenario.ts`): validates the overrides, computes an **input hash**, returns the cached forecast if present, else runs the predictor (spawned tsx under Node 20, **heap-capped**), caches, returns. DB access only in the handler (bundle-leak invariant).
- **Cache:** a `scenario_cache` table in contributions.db keyed by input hash → forecast JSON + created_at (TTL/LRU evict). Makes shared URLs and repeats instant and shields the box from repeated ML runs.
- **OOM safety (load-bearing — we OOM'd the box 2026-06-28):** cap the predictor heap (`--max-old-space-size`), **debounce** Tier-B knob changes (~600 ms), **single-flight** per box (a lock so two scenarios don't run the model at once — reuse the admin-job-worker lock pattern or a simple mutex), and rate-limit per IP. Consider routing Tier-B through the existing **admin-job queue** worker so heavy runs are serialized.

## 6. State in the URL (shareable)

A `paletteSearchCodec` (in `prediction-scenario.ts` or a new `palette-state.ts`) encodes **all** knobs into compact search params: `event`, `win`, `seed`, `mode`, `pct`, `lineup` (delta: +slug,-slug), `judges` (caption→judge map), `nudge` (corpsKey→±value), `sort`, `group`, `ranges`. Decoding rebuilds the exact scenario; Tier-B inputs are hashed for the cache. Round-trip safe + refresh-safe, mirroring `prediction.tsx`'s codec.

## 7. UX / layout

- **Left rail — the palette (knobs):** event selector → lineup editor (chips, add/remove) → judge panel → season-progress/baseline sliders → per-corps nudges → display toggles → "Copy share link" / Reset. Tier-B knobs show a subtle "recompute" affordance + spinner.
- **Main — results:** the predicted ranking, each row with the corps's **logo + accent color** (reuse `corpsPalette`) and **canonical name**, scores with likelihood ranges, and **Δ vs. base** (rank/score change) so each knob's effect is legible. Reuse `ScoreRecapTable`/`full-recap-table` (add an optional `baseRecap` for deltas).
- Wrap the results in `SectionErrorBoundary`; mobile = stacked (knobs collapse into a sheet).

## 8. Files

- NEW `app/routes/predict/palette.tsx` (route + loader; remember to extract `routeTree.gen.ts` post-build).
- NEW `app/components/predict/palette-knobs.tsx` (the rail) + `palette-results.tsx`.
- NEW `app/lib/server-fns/scenario.ts` (`runScenarioPrediction`, cache).
- NEW `sdk/scripts/scenarioPredict.ts` (or `predictEventRecap --scenario-json`).
- MODIFY `sdk/src/prediction.ts` + `v9PredictionFeatures.ts` — extract `predictFromInputs`.
- MODIFY `app/lib/prediction-scenario.ts` — `applyLevers` + `paletteSearchCodec`.
- MODIFY contributions schema — `scenario_cache` table.
- Reuse corps color/logo + the recap tables.

## 9. Phases

- **P0 — Page + base:** `/predict/palette?event=` loads + renders the base forecast with canonical corps + logos/colors. URL state scaffold.
- **P1 — Tier-A knobs:** likelihood window, roll, per-corps total nudge, sort/group, Δ-vs-base. Fully client-side. **Ships real value alone.**
- **P2 — Predictor parameterization (spike → build):** `predictFromInputs` + `scenarioPredict.ts`. De-risk the ML coupling here.
- **P3 — Tier-B knobs:** `percent_through` + `mode` first (already supported), then **lineup** + **judge panel** via the parameterized core; `runScenarioPrediction` + `scenario_cache` + OOM guards.
- **P4 — Polish:** per-caption nudges, A/B compare, share-link UX, empty/error/mobile.

## 10. Risks / non-goals

- **ML-coupling refactor (P2)** is the dominant risk — spike `predictFromInputs` before committing to lineup/judge knobs.
- **OOM/perf** — Tier-B must be capped + cached + single-flight (§5); never run unbounded model invocations from a web request.
- **Non-goals (v1):** training/fine-tuning the model from the page; persisting named scenarios server-side (URL is the share unit); auth gating (public tool).
