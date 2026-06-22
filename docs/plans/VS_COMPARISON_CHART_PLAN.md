# VS Comparison Chart — implementation plan

Status: planned (2026-06-22, rev 2 — data assumptions verified against the DB). Not started.

## Goal

A reusable `<VsChart>` component that plots multiple score "series" on one line
graph for comparison, with a guided "Add more" builder, a legend of active
series, and **all state in query params** for shareable links. It ships in two
places off one shared component:

- **`/corps/[slug]`** — replaces/augments the existing "2026 Season Scores" card.
  Pre-seeded with that corps's current season; an **"Add more to compare"**
  expander lets you stack other corps/seasons/predictions/baselines.
- **`/vs`** — a new standalone page: the same component, defaulting to a useful
  current-season view with presets, for free-form play.

## Key design decisions (confirmed with product + verified against data)

1. **X-axis = % through season (0–100).** This is the crux and it is **verified
   sound**: `competitions.percent_through` exists for every season 2013–2025 plus
   2026, computed by one date-linear formula (season's first competition = 0,
   finals = 100; `sdk/src/relational.ts:4855`). All seasons share an identical
   definition, so cross-season/baseline series genuinely align. Tooltip still
   shows the real date/event/label for date-bearing series.
2. **Three series types in v1, OVERALL TOTAL only (no caption-level in v1):**
   - **Corps × season** — a corps's line for a season. Historical = actual only;
     **current (2026) = actual-so-far (solid) + predicted-to-finals (dashed)**.
   - **Prediction as-of date** — a prediction snapshot (`predicted_at`).
     **Current season (2026) only — hidden for pre-2026** (no historical snapshots
     exist; see Data realities).
   - **Generic Nth-place baseline** — the reference curve for an Nth-place corps
     (e.g. "13th place"). This is an explicitly wanted feature. Rank 1–25.
     **No division selector** — the curve data is division-agnostic (see below).
   - Caption-level series are **out of scope for v1** (total/overall only). Avoids
     the incomplete-VA curve data and keeps the builder simple. Noted as a follow-up.
3. **Guided builder flow** for "Add series": pick a type → contextual fields
   appear (corps search + season pills; as-of date; rank). Each completed series
   becomes a legend row with a color swatch and a remove button.
4. **Compact token-per-series URL encoding**, following the existing comma-list
   convention (merch `store`, judge `captions`). One `s` param. See "URL encoding".
5. **Shared component, both routes.** `/corps/[slug]` seeds it; `/vs` defaults to
   a current-season view.
6. **Tooltips everywhere** — both the chart hover tooltip *and* UI affordance
   tooltips (base-ui `Tooltip`) on the axis ("Season progress — 0%=first show,
   100%=finals"), the % axis itself, baseline rows ("generic Nth-place corps,
   averaged across seasons"), the as-of-date control, and the add/remove buttons.

## Data realities (VERIFIED against sdk/dci-relational.db, 2026-06-22)

- **`percent_through` is a RUN/competition-level scalar**, 0–100, date-linear over
  the season's competition span (`relational.ts:4855`; prediction-run chain in
  `predictEventRecap.ts:1239`). Not weighted by number of events.
- **Prediction tables are 2026-ONLY.** `model_event_prediction_runs`/`_rows` have
  **zero rows** for any season < 2026. For 2026 there are ~138 `predicted_at`
  snapshots per top corps → "predictions as-of date" is a real multi-valued
  dimension, but **only for the live season**. ⇒ prediction series + the predicted
  overlay on a corps line exist for 2026 only.
- **Historical actuals need NO prediction run.** `corps_scores` joins
  `competitions` via `competition_slug`; `competitions` carries `date`,
  `percent_through` for all seasons 2013–2025 (verified 100% non-null for 2024/25
  Blue Devils). So a "2025 Blue Devils" line = a plain join, one actual per
  competition. This is simpler than rev 1 assumed.
- **Baseline curves are division-agnostic.** `referenceCurvesV4.json` keys are
  legacy `rank-bucket` only (no division prefix), so `getV9CaptionBaseline`'s
  division lookups always miss and fall through to legacy. The `division` param is
  effectively dead → **drop it from the builder.** Effective ranks **1–25**;
  buckets every 5 (0,5,…,100). `VA` is absent in 170/551 entries.
- **Baseline TOTAL is weighted, not a plain sum.** Use `totalFromV9Captions`
  (`sdk/src/training/v9PredictionFeatures.ts:76`):
  `GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`. A plain 8-caption sum overstates by
  ~50%. This same util must produce totals for predicted/actual/baseline alike so
  the lines are comparable. Define a VA fallback (e.g. impute from VP) for the
  170 entries missing it, or the total breaks.
- Chart stack today: **Recharts 3.8.1** `ComposedChart` in
  `app/components/corps-score-chart.tsx`; custom `ScoreLegend`/`ScoreTooltip` there.
- Routing: **TanStack React Router**; URL↔state via `app/lib/use-search-sync.ts` +
  a `SearchCodec` + XState. Reference codecs: `merch-filter-machine.ts`,
  `prediction-machine.ts`.
- Data layer: **Effect + libsql** (no Drizzle/Prisma). Read-model preferred on the
  serve host; relational/builder fallback. Prediction tables are NOT in the
  read-model db — the 2026 predicted/snapshot paths use the relational/service path.
- UI primitives: `Card`/`CardContent`, `@base-ui/react` `Popover`/`Select`/`Tooltip`,
  `CaptionMultiSelect` pattern, `FilterChips`/`SeasonChips`, `cn()`, OKLCH tokens,
  `data-slot`, `motion/react`. No `/vs` route exists yet.

## Series model (the core abstraction)

`app/lib/vs/types.ts`:

```ts
type VsSeries =
  | { kind: 'corps'; corpsSlug: string; season: string }      // actual (+predicted if 2026)
  | { kind: 'prediction'; corpsSlug: string; asOf: string }   // 2026 only; season implicit = current
  | { kind: 'baseline'; rank: number };                       // 1..25, generic Nth place
```

No `metric` field in v1 (total only). Each `VsSeries` resolves to a
**`VsResolvedSeries`**: `{ id, label, color, lines }` where `lines` is 1–2
`{ style:'solid'|'dashed'; points: { pct:number; value:number; date?:string; eventLabel?:string }[] }`.
A 2026 corps series yields two lines (actual solid + predicted dashed); historical
corps and baselines yield one.

## INVARIANTS (must hold)

- Every point has `pct ∈ [0,100]`; gaps render as gaps, never 0.
- **One total formula** (`totalFromV9Captions`) for predicted, actual, and baseline.
- Token round-trip: `decode(encode(s)) === s`, defaults omitted, malformed tokens
  dropped (never throw).
- Builder only ever offers valid values (corps's real appearance seasons; ranks
  1–25; real `predicted_at` dates) so the URL never claims a series that can't render.
- Seed corps on `/corps/[slug]` is implicit and omitted from `?s=` when it's the
  sole series (canonical URL), mirroring the season-chip "omit default" rule.

## URL encoding

One `s` param, comma-separated tokens, `~`-delimited fields; defaults omitted:

- `?s=corps~blue-devils~2026`
- `?s=corps~blue-devils~2026,corps~blue-devils~2025` (2025 vs 2026)
- `?s=corps~blue-devils~2026,baseline~13,pred~bluecoats~2026-06-01`

`baseline~<rank>` (no division). `pred~<slug>~<asOf>` (season implicit = current).
On `/corps/[slug]`, the page's corps seeds `s` when absent.

## Milestones (commit each; ordered by value + risk)

### M0 — Total util + season-general percent-through helper (prerequisite)
- Extract/confirm `totalFromV9Captions` as the single total source; add VA fallback.
- `app/lib/vs/pct.ts`: given a corps+season, return actual points via
  `corps_scores → competitions.percent_through`. Pure, season-general.

### M1 — Resolvers + RPC (the easy two first)
- `app/lib/vs/resolve.ts`: **corps-historical** (join) and **baseline**
  (`getV9CaptionBaseline` per 5% bucket → `totalFromV9Captions`) resolvers.
- Server fn / RPC `resolveVsSeries(series[])`, cached per token.
- Deterministic color per id (reuse `corpsPalette()` for corps so brand hue is
  kept; categorical ramp for baselines).

### M2 — `<VsChart>` presentational component
- `app/components/vs/vs-chart.tsx`: Recharts `ComposedChart`, XAxis=`pct` 0–100
  (ticks 0/25/50/75/100, label "Season progress"), one/two `<Line>` per series.
- Lift `ScoreLegend`/`ScoreTooltip` out of `corps-score-chart.tsx` into
  `app/components/vs/` so the old card and new chart share them. Interactive legend
  rows (swatch + label + remove ×). Hover tooltip lists every series' value at the
  hovered pct + real date/event when present. SSR placeholder/`mounted` to avoid CLS.
- base-ui `Tooltip` on axis label, baseline rows, controls (see decision 6).

### M3 — `/vs` route (ships a useful page on M1+M2)
- `app/routes/vs.tsx`: `validateSearch` for `s`; loader resolves initial series
  server-side (SSR-shareable).
- **Default (no `s`): current-season view** — e.g. top corps of 2026 so far.
- **Presets** (one-click, set `s`): "2026 top 3", "BD 2024 vs 2025 vs 2026",
  "Your corps vs 13th place". **Filters** to swap season / add a baseline.
- Short **explanation** blurb of the % axis + what baselines mean.

### M4 — State machine + URL sync
- `app/machines/vs-machine.ts` (XState): `series[]` + expander/builder UI state;
  resolved data fetched via M1 RPC on change.
- `app/lib/vs/codec.ts` `SearchCodec` ⇄ `s` tokens; wire via `useSearchSync`,
  `replace:true`, `resetScroll:false`.

### M5 — Guided "Add series" builder
- `app/components/vs/add-series.tsx`: base-ui `Popover` from an "Add to compare"
  button in an expandable section (`useState` expander, established show/hide pattern).
- Type chooser (Corps / Prediction / Baseline) → contextual fields:
  - **Corps**: searchable corps combobox + `SeasonChips` constrained to that
    corps's appearance seasons.
  - **Prediction** (only shown when current season available): corps + as-of date
    picker constrained to real `predicted_at` snapshot dates.
  - **Baseline**: rank stepper 1–25 (no division). Tooltip explains "generic
    Nth-place corps".
- "Add" pushes a `VsSeries`; editing a legend row reopens pre-filled.

### M6 — Corps-page embed
- `app/routes/corps/$slug.{-$season}.tsx`: swap the "2026 Season Scores" card body
  for `<VsChart>` seeded with `{kind:'corps',corpsSlug,season}` when `s` absent;
  render the "Add more to compare" expander. Keep the current single-series look
  (incl. uncertainty band) until a second series is added.

### M7 — Prediction-as-of resolver (2026-only, the hard one, last)
- Resolve `pred~slug~asOf`: latest snapshot `predicted_at <= asOf` per event across
  the season; plot predicted_total by `percent_through`. Gate UI to current season.

## Edge cases
- Corps entering late: line starts at pct ~20 — render gap, don't imply 0.
- Same-day shows → near-identical pct: dedupe/last-wins by event (as current builder).
- Corps absent from a season → no selectable season (builder prevents it).
- 2026 mid-season corps = actual(solid)+predicted(dashed) from one token; historical = one line.
- Baseline rank>25 / off-bucket pct: clamp/snap, and only offer valid values so URL ≠ render.
- VA-missing curve entries: defined fallback or total is wrong.
- Series cap (e.g. 6) with a visible message — no silent truncation.

## Open questions
- Baseline label wording now that division is gone — "13th place" vs "13th-place
  baseline (all-class avg)"? Tooltip carries the nuance.
- Preset list for `/vs` — finalize the 3–4 presets.

## Follow-ups (not v1)
- Caption-level series (needs VA backfill in curves).
- Per-series hide toggle, drag-reorder legend.
- Same-corps two-as-of-dates "snapshot diff" shortcut.
- Saved/named comparisons beyond the URL.
