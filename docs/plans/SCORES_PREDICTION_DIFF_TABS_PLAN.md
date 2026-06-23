# 2026 Scores / Prediction / Diff tabs — prediction.tsx

Status: DRAFT for review
Created: 2026-06-23

## 0. TL;DR / Goal

Right now the event recap page (`/events/$yearSlug/$slug/prediction`) hard-forks on `yearSlug !== '2026'`: 2026 gets Monte Carlo predictions only, past seasons get real scores only. But the 2026 season is about to start, and actual scores will roll in alongside the existing predictions.

Add a segmented tab control (`Scores | Prediction | Diff`) to the recap section header so the user can flip between all three views on the same page for 2026 events. The current binary `isPastSeason` fork persists for pre-2026 data, but 2026 becomes a tri-modal page:

- **Scores** — the actual scored recap (same table as past seasons, with Full Recap toggle)
- **Prediction** — existing Monte Carlo prediction view (roll, ranges, likelihood window)
- **Diff** — new view: compact recap with per-subcaption `[Scored] [Predicted] [±Diff]` triplets, color-coded by direction and magnitude

## 0.1 Grounding — verified facts (2026-06-23)

- The fork is a single line: `const isPastSeason = params.yearSlug !== '2026'` at `app/routes/events/$yearSlug/$slug/prediction.tsx:345`.
- For 2026 the route loader returns `recap: null` and the server-fn branch at `app/lib/server-fns/hybrid.ts:395` never queries the recap builder — it only runs `getCached2026EventPrediction`.
- Scores and predictions both key on `corps_key` (string). All three data sources — compact recap (`RecapRowOut`), prediction rows, and full recap (`FullRecapCorps`) — carry the same identifier.
- Both have 8 subcaptions: `GE1, GE2, VP, VA, CG, MB, MA, MP` plus aggregate columns `total, GE, Visual, Music`. Prediction rows additionally carry `caption_intervals` (`{ p10, p50?, p90 }`).
- The 2026 prediction model lives in `model_event_prediction_runs.payload_json` → `predictions[]` with field names matching the recap builder output (`GE1`, `GE2`, …). The `recap` summary field is the same shape as `RecapRowOut` (structurally assignable to `RecapRow`).
- No tab component exists in the codebase. The established segmented-control pattern is `<ToggleGroup variant="outline" spacing={0}>` (used for the Likelihood window selector at prediction.tsx:1155).
- The section heading is an `<h2>`: "Recap Prediction" (current 2026, line 1074) or "Scores" (past seasons). The toolbar lives inside `<CardHeader>` above the table.
- The `scoreTableMachine` (past-season scores) and `predictionMachine` (2026 prediction) are separate machines with no shared view state.
- `scoreTableMachine` already has a `showFullRecap` toggle + `fullSorts` + compact↔full sort mirroring — this pattern is the closest precedent for view-switching within the same page.
- URL sync codes are already per-machine (`predictionSearchCodec`, `scoreTableSearchCodec`).

## 1. Design decisions

1. **Tab control = `<ToggleGroup spacing={0} variant="outline">`** — consistent with the Likelihood window toggle. Single-select, mutually-exclusive. Each item: icon + short label. Items rendered conditionally based on data availability.

2. **URL-driven view state.** New `view` search param: `scores | prediction | diff`. Default: `prediction` when scores don't exist; `scores` once scores are released (show the real data first). Encoded via `useSearchSync` in the codec.

3. **Unify machine, don't fork component.** Instead of three separate machines or three separate component branches, add a `view` field to the prediction machine's `params` region. The machine already owns the `baseRecap` (predicted means) — add `scoredRecap` (actual scores). The current `status` region (idle/loading/ready/error) stays prediction-only; scores load in the route loader (SSR, like past seasons). The diff is computed in-render from the two data sources — no separate fetch.

4. **Diff view = compact recap, with per-subcaption triplets.** Each subcaption gets three sub-columns: `Scored | Predicted | ±Diff`. Tiered headers (subcaption name spanning its three children), reusing the `buildFullRecapModel`-style column banding pattern. Aggregates (total/GE/Visual/Music) are NOT tripled in the diff view — they're derived from subcaptions and would be redundant.

5. **Only show tabs whose data is available.** If no prediction exists for a 2026 event, hide the Prediction and Diff tabs. If no scores exist yet, hide the Scores and Diff tabs. Single-tab = no segmented control, just the heading (today's behavior).

6. **Sort/group/filter state is per-view, with mirroring where columns overlap.** Each view has its own sort list (`sorts` for Scores/Prediction, `diffSorts` for Diff). The `CYCLE_SORT` event is view-aware. Shared columns (total, GE, Visual, Music, 8 subcaptions) mirror sort direction across views, following the compact↔full mirroring precedent in `score-table-machine.ts:24-59`. Group-by-class and class filters are shared across all three views.

7. **Full Recap toggle lives in Scores view only.** Prediction has no judge data. Diff uses a diff-specific full-recap equivalent only if judge-level scores exist and the prediction model eventually outputs judge-level forecasts (out of scope for now — see §8).

8. **Ranges toggle lives in Prediction view only.** Scored and Diff views are point values; there are no prediction intervals to show.

## 2. Current state → Target state

### Current (2026 events)

```
PageHeader (h1: "2026 Event Name")
  └─ Toolbar: [Roll] Likely|Poss|Unlikely | Ranges | Group | Stack|Excl | Clear
       └─ h2 "Recap Prediction"
            └─ ScoreRecapTable (predicted mean rows, Monte Carlo scenario)
                 └─ LineupSchedule
```

### Target (2026 events)

```
PageHeader (h1: "2026 Event Name")
  └─ Toolbar: [Scores | Prediction | Diff]  |  view-specific controls ...
       └─ Table (content depends on active view)
            └─ LineupSchedule
```

**Scores view toolbar:** Ranges | Group | Sort mode | Clear |  FullRecap/Compact toggle
**Prediction view toolbar:** [Roll] Reset  |  Likely|Poss|Unlikely | Ranges | Group | Sort mode | Clear
**Diff view toolbar:** Group | Sort mode | Clear  |  (no Roll, no Ranges, no Likelihood)

### Data flow change

```
Before (2026):
  loader → getHybridEventPredictionPageData
    → prediction (from model_event_prediction_runs)
    → event, schedule, corps
    → recap = null

After (2026):
  loader → getHybridEventPredictionPageData
    → prediction (from model_event_prediction_runs, may be null)
    → recap (from EventRecapService, may be null if scores not released)
    → event, schedule, corps
    → fullRecap (when recap exists — preload judge-level for Scores view, same as past seasons)
```

## 3. Diff computation

### `sdk/src/diff.ts` (new pure module, sdk so it's shared with admin/tooling)

```ts
type DiffCaption = {
  scored: number | null;    // actual score, or null if corps not scored
  predicted: number | null; // predicted mean, or null if corps not in prediction
  diff: number | null;      // scored - predicted (null if either is null)
};

type DiffRow = {
  corps_key: string;
  corps: string;
  division?: string;
  rank?: number;
  total: DiffCaption;
  ge: DiffCaption;
  visual: DiffCaption;
  music: DiffCaption;
  captions: Record<Caption, DiffCaption>;
};
```

**Joining:** Full outer join on `corps_key`. Corps in scores but not prediction → `predicted = null, diff = null`. Corps in prediction but not scores → `scored = null, diff = null`.

**Color coding** (light/dark aware tokens):
- `diff > 0` (scored higher than predicted, corps overperformed): **green** — `var(--diff-positive)` / `#16a34a`
- `diff < 0` (scored lower than predicted): **red** — `var(--diff-negative)` / `#dc2626`
- `diff ≈ 0` (within 0.05): **muted** — `var(--text-tertiary)`
- Magnitude encoding: opacity/saturation scales from 0.3 (small diff) to 1.0 (large diff), clamped by percentile. A 0.1-point difference for a subcaption is huge; a 1-point difference for total is moderate. This is **per-column relative** (the scale is within each column's diff range, not absolute).

**Decision pending:** the exact magnitude scale — relative (percentile within column) or absolute (fixed thresholds per caption type). Relative avoids the problem of different caption scoring ranges but depends on the spread of that event. This is an open question (Q4).

**Summary row** (optional footer): mean absolute error per subcaption, number of corps with diff > 0.1, number with diff < -0.1.

### CSS tokens (new, in `app/app.css`)

```css
:root {
  --diff-positive: oklch(0.55 0.22 142);   /* green */
  --diff-negative: oklch(0.55 0.25 22);    /* red */
  --diff-neutral: var(--text-tertiary);     /* muted */
}
```

## 4. Phases

### P0 — Data layer: fetch both scores + prediction for 2026

- [ ] **Modify `getHybridEventPredictionPageData`** (`app/lib/server-fns/hybrid.ts:395`):
  - In the 2026 branch, also query `EventRecapService.getEventRecap(competitionSlug)` in parallel.
  - The recap lookup needs the competition slug — resolve it first (either the event slug itself, or via `buildCompetitionSlugForSeasonEvent` if the event slug ≠ competition slug).
  - Return `recap: EventRecap | null` alongside `prediction: PredictionSummary | null`.
  - Both may be `null` independently (no scores yet, no prediction yet).
- [ ] **Modify route loader** (`prediction.tsx:198`):
  - Remove the `wantFull = yearSlug !== '2026'` gate — whenever a recap exists (including for 2026), preload the full recap.
  - `fromServer` fetches both `getHybridEventPredictionPageData` and (conditionally) `getHybridEventFullRecap`.
  - The `loadDetailOrServer` shard path stays for past seasons; 2026 stays live (server-fn always).
- [ ] **Corps resolution:** the 2026 corps directory should be the union of: prediction corps_keys + recap corps_keys + schedule corps_keys + full-recap corpsKeys. Handle the case where each source is independently null.

**Accept:** For a 2026 event with scores in the DB, the loader returns both `prediction` and `recap` (non-null). For a 2026 event without scores yet, `recap` is `null`. Existing past-season pages are unaffected.

### P1 — Diff computation utility

- [ ] **Create `app/lib/diff.ts`** with:
  - `computeDiff(scoredRows: RecapRow[], predictedRows: RecapRow[]): DiffRow[]`
  - Pure function — no Effect, no DB, no side effects.
  - Full outer join on `corps_key`; resolve display name from whichever side has it.
  - Per-caption diff = `(scored ?? NaN) - (predicted ?? NaN)` → `null` if either is missing.
  - Aggregate diffs computed from subcaption diffs (to avoid double-encoding when one source has aggregates and the other doesn't): `ge = ge1 + ge2`, `visual = (vp+va+cg)/2`, `music = (mb+ma+mp)/2`, `total = ge+visual+music`.
  - Add `diff_caption_keys` array (`['GE1','GE2','VP','VA','CG','MB','MA','MP']` and `'total'` only).
- [ ] **Unit tests** for `computeDiff`: matching corps, extra-in-scores, extra-in-prediction, partial subcaption data, empty inputs.

**Accept:** TypeScript compiles, tests pass.

### P2 — Machine changes

- [ ] **Add `view` to `predictionMachine` context** (`app/machines/prediction-machine.ts`):
  ```ts
  view: 'scores' | 'prediction' | 'diff';  // default 'prediction'
  scoredRecap: RecapRow[] | null;
  ```
- [ ] **Add `scoredRecap` to `input`** — seeded from the route loader data.
- [ ] **Add `SET_VIEW` event** — switches `view`, preserves shared sort/group/filter state, applies sort mirroring.
- [ ] **Add `diffSorts`** to context (parallel to `sorts` for Prediction view).
- [ ] **Make `CYCLE_SORT` view-aware:** dispatches to the active view's sort list (`sorts` for Scores/Prediction, `diffSorts` for Diff). Mirrors between compact sorts and diff sorts where keys overlap.
- [ ] **Update `predictionSearchCodec`** (`prediction-scenario.ts`):
  - Add `view` param: `encode` writes it (omit default), `decode` reads it.
  - Type: `'scores' | 'prediction' | 'diff'`. Default: `'prediction'` when no scores exist, else `'scores'`.
- [ ] **Dynamic default view:** When `scoredRecap` is non-null and `prediction` is null → default `scores`. When both exist → default `scores` (real data first). When only prediction → default `prediction`.

**Accept:** Machine state includes `view`; URL reflects active view (`?view=scores`); switching views updates the table without a full page reload.

### P3 — Tab UI (segmented control + heading replacement)

- [ ] **Replace `<h2>Recap Prediction</h2>` / `<h2>Scores</h2>`** with a segmented control in the toolbar/CardHeader area.
  - Use `<ToggleGroup variant="outline" spacing={0}>` pattern (matching Likelihood toggle).
  - Items: `Scores`, `Prediction`, `Diff` — each with an icon + label.
  - Icons: `chartBarLine01Icon` (Scores), `diceIcon` or `robot02Icon` (Prediction), `compareIcon` or `arrowUpDown03Icon` (Diff) — from `~icons/hugeicons/*`.
  - Only render items whose data exists (see §1.5): `scoredRecap != null` → Scores tab visible; `prediction != null` → Prediction tab visible; both → Diff tab visible.
  - When only one tab is available, render a plain `<h2>` heading instead (same as today).
  - `onValueChange` dispatches `SET_VIEW` event to the machine.
- [ ] **Conditional toolbar controls per view:**
  - Scores view: Ranges toggle*, Group toggle, Sort mode toggle, Full Recap/Compact toggle, Clear Filters.
  - Prediction view: Roll button, Scenario counter, Likelihood toggle-group, Ranges toggle, Group toggle, Sort mode toggle, Clear Filters.
  - Diff view: Group toggle, Sort mode toggle, Clear Filters.
  - Use `<Show when={view === '...'}>` to conditionally render.
- [ ] **`AnimatePresence` for table transitions** — when switching views, the table rows morph using shared `layoutId` (like the compact↔full recap swap already does in `score-recap-table.tsx`).

*The Ranges toggle in Scores view: past seasons show actual score ranges (`computedRanges` using `caption_intervals`). For 2026 Scores view, there are no prediction intervals (the scores are real, not predictions), so Ranges should be hidden or disabled. This is an open question — see Q3.

**Accept:** Segmented control renders in the header; clicking a tab switches the table; only available tabs appear; the table content changes with the active view.

### P4 — Scores view for 2026

- [ ] **Reuse `PastSeasonScoresPage` logic** — or extract the shared scores-view code.
  - The `ScoreRecapTable` component already handles Scores view for past seasons.
  - For 2026, seed it with `scoredRecap` from the machine context instead of the route loader's `recap` field.
  - Pass the Full Recap toggle + full recap data (preloaded in loader when scores exist).
  - The `showFullRecap` toggle and `fullSorts` live in the machine context.
- [ ] **Readiness chips:** When scores have arrived for a 2026 event, the "Prediction" readiness chip in PageHeader should be supplemented or replaced by "Scores". (This is cosmetic; see §8 for deferred items.)

**Accept:** For a 2026 event with scores, clicking the Scores tab shows the real scored recap table (identical to how past seasons look), including the Full Recap toggle.

### P5 — Diff table component

- [ ] **Create `app/components/prediction/diff-recap-table.tsx`**:
  - Accepts: `rows: DiffRow[]`, `sortState`, `groupByClass`, `classFilters`, `onCycleSort`, `corpsLookup`, `searchCodec` etc. — matching the props pattern of `ScoreRecapTable`.
  - **Column model** (tiered headers, reusing `buildFullRecapModel` banding pattern conceptually but simpler):
    - Fixed left: Rank | Corps | Class
    - Then 8 subcaption bands, each spanning 3 sub-columns: `Scored | Predicted | ±Diff`
    - Each subcaption band has the caption name (GE1, GE2, VP, etc.) as a single spanning header, underneath which are the 3 sub-headers.
  - **Cell rendering:**
    - Scored cell: plain number (muted if no prediction counterpart)
    - Predicted cell: plain number (muted if no score counterpart)
    - Diff cell: number with `+`/`-` sign, colored via `var(--diff-positive)` / `var(--diff-negative)`, with background tint scaled by magnitude. Show `—` when diff can't be computed (one side missing).
    - Tooltip on hover: shows the three values with their exact diff.
  - **Per-column magnitude scale:** compute the absolute diff range for each subcaption column, map to opacity/saturation values. A diff of 0.1 in GE1 (range typically 0.5–1.0) gets brighter color than 0.1 in total (range 60–90).
  - **Sorting:** each diff sub-column is sortable (3-state cycle: none→desc→asc). Sorting by `Scored` or `Predicted` shows the original value order; sorting by `Diff` shows signed difference order. `diffSorts` encodes `ge1:scored:desc` / `ge1:diff:asc` style keys in `fsort`.
  - **Ranks:** computed per column + per scope (grouped / overall), like `computeLeafRanks` in full recap.
  - **Horizontal scroll:** same sticky-column pattern as compact/full recap (Rank + Corps fixed left, `data-scrolled` engagement).
- [ ] **Summary row (optional):** a sticky footer row showing mean absolute error per subcaption. Design detail deferred — consider a collapsible panel or a separate `<StatsRow>` below the table. (Open question Q5.)

**Accept:** Diff table renders with color-coded diffs; sorting works per column; groups by class; horizontal scroll with sticky columns; corps with only scores or only predictions are shown with partial data.

### P6 — Polish, edge cases, URL sync

- [ ] **URL sync:** `view` param persists across navigation (e.g. going back to the events directory and returning to this event remembers the last active view). Determine whether `view` should be in the shareable URL or just a transient client state. (Q2.)
- [ ] **Empty states:**
  - No scores yet: Scores and Diff tabs hidden; shows "Scores not yet released" badge in header.
  - No prediction: Prediction and Diff tabs hidden; shows "Prediction not available" note.
  - Corps with no counterpart: render with muted values + tooltip explanation ("Not in prediction model" / "Did not compete").
- [ ] **Mobile:** tabs should wrap or scroll horizontally (`overflow-x-auto`). Icons only on small screens (hide text label, keep icon + tooltip).
- [ ] **A11y:** `role="tablist"` / `role="tab"` / `aria-selected` on ToggleGroup items (Base UI's `ToggleGroup` may already provide this — verify).
- [ ] **`vp check`** passes on `app/`; `npx tsc --noEmit -p tsconfig.json` in `sdk/` has no new errors.

**Accept:** URL reflects active view; empty/partial states render gracefully; mobile layout works; no type errors.

## 5. File map

```
app/
  lib/
    diff.ts                                    # NEW — computeDiff pure function
    prediction-scenario.ts                     # MODIFY — add diffSorts, view-aware codec
  machines/
    prediction-machine.ts                      # MODIFY — add view, scoredRecap, diffSorts, SET_VIEW
  components/prediction/
    diff-recap-table.tsx                       # NEW — Diff table component 
    score-recap-table.tsx                      # MODIFY — accept optional title slot for tab control
    past-season-scores.tsx                     # REFACTOR — extract shared scores-view logic
  routes/events/$yearSlug/$slug/
    prediction.tsx                             # MODIFY — tab UI, conditional toolbars, view routing
  app.css                                      # MODIFY — diff color tokens (--diff-positive, --diff-negative)

sdk/
  src/
    diff.ts                                    # NEW — shared diff types + computeDiff (conceptually same as app/lib/diff.ts)
  scripts/
    (no new scripts — diff is computed in-app from existing data)

app/lib/server-fns/
  hybrid.ts                                    # MODIFY — 2026 branch also fetches recap + full recap
```

## 6. Risks & mitigations

- **R1 — Corps mismatch between scores and predictions.** Exhibition corps, late additions, or model exclusions cause one-sided rows.
  - *Mitigation:* Full outer join in `computeDiff`; show `—` for missing columns; tooltip explains the reason.

- **R2 — 27-column diff table is very wide.** Even with horizontal scroll, 8 subcaption bands × 3 sub-columns each, plus 3 fixed columns = 27 columns.
  - *Mitigation:* Stick Rank+Corps+Class columns (same as existing). Show only 8 subcaptions (no aggregates), keeping it narrower than 8×3+4×3=36. If still too wide, narrow sub-columns to 3 digits + sign (no decimal) for diff values. *Alternative:* the stacked-cell format (all 3 values in one cell) is a fallback if triple columns prove too wide on typical screens.

- **R3 — Mid-season transitions.** Some 2026 events have scores, others don't. The page must handle the transition from "prediction-only" to "both" gracefully.
  - *Mitigation:* The loader independently fetches both sources; each may be `null`. The tab visibility is gated on each being non-null. No event needs special-case handling.

- **R4 — Sort state drift across views.** Switching views and back should preserve your sort/filter choices.
  - *Mitigation:* Per-view sort lists (`sorts` for Scores/Prediction, `diffSorts` for Diff). Mirroring on shared columns. Group and class filters are shared.

- **R5 — The 2026 prediction might not exist for all events.** Some events may only have scores.
  - *Mitigation:* This is already handled — `prediction = null` hides the Prediction and Diff tabs. The page reduces to the Scores-only view (like past seasons).

## 7. Testing strategy

- **`computeDiff` unit tests** — matching corps, missing corps, partial subcaptions, empty inputs, 0-diff edge case. Run in `sdk/` test suite.
- **Machine transition tests** — `SET_VIEW` preserves sort/group state; `CYCLE_SORT` dispatches to correct view's sort list.
- **Manual verification:**
  - Visit a 2026 event with scores in `dci-relational.db` (once available) → all three tabs render.
  - Visit a 2026 event without scores yet → only Prediction tab (or only heading if no prediction either).
  - Visit a past-season event → unchanged (no tabs, just Scores with Full Recap toggle).
  - Switch tabs → table morphs with `AnimatePresence`; sort/filter persists.
  - URL encodes/decodes `view` param correctly.
- **`vp check`** on `app/` — no new type errors.

## 8. Open questions

- **Q1 — What icons for each tab?** Proposal: `chartBarLine01Icon` (Scores), `diceIcon` (Prediction), `compareIcon` (Diff) from Hugeicons. **Decision deferred to implementation — try them and iterate.**

- **Q2 — Should `view` be a persistent URL param or transient client state?** If in the URL, sharing the link preserves the active view. If transient, the page always defaults to `scores` (real data first). **Recommendation: URL param** — consistent with all other view state (sort, ranges, group, etc.) and the existing `recap=full` param for the full recap toggle. But the default `view=scores` should be omitted from the URL to keep links clean until the user explicitly chooses a different view.

- **Q3 — Should Scores view show Ranges?** For 2026, the scores are real point values, not predictions — there are no prediction intervals. The Ranges toggle would need a different data source (e.g. model-recomputed intervals around the actual scores, or percentile ranges from the 2026 season so far). **Recommendation: hide Ranges in Scores view for 2026, keep it in Prediction view.** Past-season Scores view doesn't have ranges either.

- **Q4 — Diff magnitude scale: relative or absolute?** Relative (percentile within the event's diff column) adapts to any event but varies between events. Absolute (e.g. |diff| > 0.3 → full color) is consistent but breaks for different subcaption ranges (GE1 range ~0.5 vs total range ~60). **Recommendation: per-column relative** — compute the max absolute diff per subcaption column and map linearly. This is what the plan assumes; validate during implementation.

- **Q5 — Summary/stats row in Diff view?** A footer showing mean absolute error, max over/under-prediction, etc. Could be a collapsible `<details>` below the table or a separate `<StatsRow>`. **Recommendation: defer to a follow-up** — the core diff table alone is already a large change. Add summary stats once the table is stable.

## 9. Out of scope / deferred

- **Full Recap Diff view** — judge-level diff (per-judge, per-subcaption scored vs predicted) requires the prediction model to emit judge-level forecasts, which it doesn't currently do. Deferred until (if) the model adds that capability.
- **Historical diff archives** — once 2026 is over, freezing the prediction-vs-actual diff as a permanent read-model artifact for retrospection. Can be done later by re-computing from the saved prediction payload + final scores.
- **Charts** — a scatter plot or heatmap visualizing the diff. Out of scope for this plan.
- **"Scores" readiness chip** — updating the PageHeader readability indicators for 2026 events. Cosmetic, can be done in a follow-up.
- **Past-season prediction backfill** — running predictions for 2025/2024/etc. and adding the Diff tab there. The model exists for 2026 only; this would require a separate ML run for each past season.

## 10. Sequencing / rollout

1. **P0 — Data layer** (sdk + hybrid.ts). Mergeable independently; no visible change to the user yet. Commit: `fetch both recap and prediction for 2026 events`.
2. **P1 — Diff computation** (app/lib/diff.ts + tests). Pure utility; no UI changes. Commit: `add computeDiff utility for scored-vs-predicted comparison`.
3. **P2 — Machine changes** (prediction-machine.ts + codec). Machine API change; no UI yet. Commit: `add view state and scoredRecap to prediction machine`.
4. **P3 — Tab UI** (prediction.tsx header + toolbar). Visible change: segmented control appears. At this point Prediction and Scores tabs work; Diff tab shows placeholder or is hidden. Commit: `add Scores/Prediction/Diff tab control to 2026 recap section`.
5. **P4 — Scores view for 2026** (wiring scoredRecap data into table). Commit: `enable Scores view for 2026 events with real recap data`.
6. **P5 — Diff table component** (diff-recap-table.tsx). Commit: `add diff comparison table with color-coded per-subcaption diffs`.
7. **P6 — Polish** (edge cases, a11y, mobile, empty states). Commit: `polish diff tabs: mobile layout, empty states, URL sync`.
8. **Follow-up** — summary stats row, readiness chips, past-season backfill (separate plans).
