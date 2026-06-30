# VS Comparison — per-caption support (filter pills)

Status: planned (2026-06-30, data verified against `sdk/dci-relational.db`). Not started.
Owner doc; extends `docs/plans/VS_COMPARISON_CHART_PLAN.md` (which ships OVERALL TOTAL only).

## Goal

Let `/vs` compare any **caption**, not just Overall Total. A single-select **pill
row above the three Add-to-compare columns** re-scopes the whole chart (every
series — corps actuals, predictions, baselines — at once), the same way the
rankings page's metric filter works. No per-series caption; one global selection.

Caption set (12): **Total · General Effect · Visual · Music · GE1 · GE2 · Visual
Proficiency · Visual Analysis · Color Guard · Music Brass · Music Analysis ·
Music Percussion.**

## Background: where the data lives (verified)

DCI score sheet → relational tables (all on `sdk/dci-relational.db`):

- `corps_scores.total_score` — **Total** (0–100ish).
- `category_scores` — the 3 scoring **categories** by `category_name`: `General
  Effect` (~40), `Visual` (~30), `Music` (~30). (Also `Timing & Penalties` —
  excluded; see Constraints.) `category_initials` is empty in the data — key on
  `category_name`.
- `caption_scores` — the 8 **captions** by `caption_initials` / `caption_name`,
  each tagged with its `category_name`:
  `GE 1` (General Effect 1), `GE 2` (General Effect 2), `VP` (Visual
  Proficiency), `VA` (Visual - Analysis), `CG` (Color Guard), `MB` (Music -
  Brass), `MA` (Music - Analysis), `MP` (Music - Percussion).
- `subcaption_scores` — Rep/Perf/Cont/Achv per judge (deeper than we need; ignore).

**The fold is already solved.** `foldRecapRows(scoreRows, captionRows, categoryRows)`
(`sdk/src/readModel/builders/recap.ts:141`) returns `RecapRowOut`, which **already
carries every field we need**: `total, GE, Visual, Music, GE1, GE2, VP, VA, CG,
MB, MA, MP`. The rankings builder (`builders/rankings.ts`) uses exactly this for
its metric column — we reuse the same path, just keep all 12 values instead of
selecting one.

Predictions: `model_event_prediction_rows` has columns `predicted_total`,
`predicted_ge`, `predicted_visual`, `predicted_music`, **plus**
`predicted_captions_json` = `{"GE1","GE2","VP","VA","CG","MB","MA","MP"}` (verified
sample). So predictions are per-caption with no new modelling.

Baselines: `getV9CaptionBaseline(...)` (`sdk/src/training/v9Baselines.ts`) already
returns `captions: Record<V9Caption, number>` (the 8). `buildVsBaselineCurve`
currently sums them via `totalOf()` and stores only the total — we store all.

## Caption taxonomy (single source of truth)

New `app/lib/vs/captions.ts` (client-safe, mirrors `app/lib/rankings/types.ts`):

```ts
export const VS_CAPTIONS = [
  'total', 'ge', 'visual', 'music',          // headline (Total + 3 categories)
  'ge1', 'ge2', 'vp', 'va', 'cg', 'mb', 'ma', 'mp', // 8 sub-captions
] as const;
export type VsCaption = (typeof VS_CAPTIONS)[number];

export const VS_CAPTION_LABELS: Record<VsCaption, string> = {
  total: 'Total', ge: 'General Effect', visual: 'Visual', music: 'Music',
  ge1: 'GE 1', ge2: 'GE 2', vp: 'Visual Prof.', va: 'Visual Analysis',
  cg: 'Color Guard', mb: 'Brass', ma: 'Music Analysis', mp: 'Percussion',
};
/** Headline captions (rendered first / emphasized). */
export const VS_CAPTION_HEADLINE: VsCaption[] = ['total', 'ge', 'visual', 'music'];
```

Mapping table (the only place each source's column/key is named):

| caption | actual (`RecapRowOut`) | prediction | baseline (V9 captions) |
|---|---|---|---|
| total | `total` | `predicted_total` | `totalOf(c)` |
| ge | `GE` | `predicted_ge` | `c.GE1 + c.GE2` |
| visual | `Visual` | `predicted_visual` | `c.VP + c.VA + c.CG` |
| music | `Music` | `predicted_music` | `c.MB + c.MA + c.MP` |
| ge1/ge2 | `GE1`/`GE2` | json `GE1`/`GE2` | `c.GE1`/`c.GE2` |
| vp/va/cg | `VP`/`VA`/`CG` | json | `c.VP`/`c.VA`/`c.CG` |
| mb/ma/mp | `MB`/`MA`/`MP` | json | `c.MB`/`c.MA`/`c.MP` |

## Data model: widen the three `rm_vs_*` tables

Decision: **wide** (one row per show/bucket, a column per caption), not a long
`caption` dimension. Rationale: reads stay a single indexed row lookup (the
read-model invariant — no fan-out), the resolver just picks a column, and the row
count is unchanged. Storage grows by 11 REAL columns per row (small; the VS
shards are tiny vs events/recaps).

Tables (emit at `sdk/scripts/emitReadModel.ts` ~L273–282 create, ~L819 insert):

- `rm_vs_corps_scores(corps_slug, season, pct, date, event_label, total, ge,
  visual, music, ge1, ge2, vp, va, cg, mb, ma, mp)` — PK `(corps_slug, season,
  pct)` unchanged.
- `rm_vs_corps_predicted(corps_slug, pct, total, ge, visual, music, ge1…mp)`.
- `rm_vs_baselines(rank, bucket, total, ge, visual, music, ge1…mp)`.

A NULL caption column = that show/corps lacks that caption (e.g. a recap with no
sub-caption panel) → the resolver drops the point (gap), never plots 0.

## Builder changes (SDK)

1. `buildVsCorpsScores` / `buildVsCorpsScoresAllSeasons`
   (`sdk/src/readModel/builders/vs.ts`): today they `SELECT cs.total_score`. Change
   to fold per (competition, corps) like rankings does — fetch the corps's
   `corps_scores` + `caption_scores` + `category_scores`, run `foldRecapRows`,
   and emit all 12 values per point. Keep the in-progress-season `pct` correction
   (`buildSeasonSpans`/`seasonPct`, just shipped) unchanged.
2. `buildVsBaselineCurve`: stop collapsing to `total`; emit `total` (=`totalOf`),
   `ge/visual/music` (category sums), and the 8 caption values from `captions`.
3. `buildVsCorps2026Predicted`: select `predicted_ge/visual/music` and
   `JSON_EXTRACT`/parse `predicted_captions_json`; emit all 12.
4. Readers (`sdk/src/readModel/readers.ts`): `readVsCorpsScores`,
   `readVsBaselines`, `readVsCorps2026Predicted` return the wide row.
5. `verifyReadModel.ts`: parity holds automatically (same builders) — re-run it.
6. Emit + publish via `scripts/refresh-prod-read-model.sh` (the live A/B hot-swap
   path). These are **server-read** tables, not client JSON shards, so there is no
   `?v=` cache version to bump — a re-emit is sufficient.

## App changes

- **Types/codec** (`app/lib/vs/captions.ts` + `app/lib/vs/codec.ts`): add a `cap`
  search param. Parsed like the rankings metric: `parseCaption(v)` → valid
  `VsCaption` or `undefined`. Canonical form **omits `cap` when `total`** (so the
  default URL and all existing shared links are unchanged). The caption is global
  → **series tokens (`corps~…`, `forecast~…`, `baseline~…`) are untouched**, so
  every existing `?s=` URL still decodes.
- **Resolver** (`app/lib/server-fns/vs.ts`): `resolveVsSeries` gains
  `caption: VsCaption` (default `total`); each `resolveOne` branch reads the
  matching column. Series whose caption value is null at a point → that point is
  skipped (existing "absent point, never 0" rule). A series with no points for
  the caption → dropped from the result (already handled).
- **Loader** (`app/routes/vs.tsx`): read `cap` from search, pass to
  `resolveVsSeries`; thread `caption` into the page + `AddCompareSection`. The
  hover-preview resolve (`onPreview`) must use the active caption too (cache key
  becomes `${caption}:${token}`).
- **UI — the pill row** (`AddCompareSection`): a `FilterChips` row at the top of
  the section (above the 3-column grid), single-select, value = active caption,
  `onSelect` navigates `cap` (with `resetScroll:false`, like series toggles).
  Reuse the shared `FilterChips` so it matches the site (and the rankings page).
- **Chart** (`vs-chart.tsx` / `chart-primitives.tsx`): Y-axis label + page
  subheading reflect the caption ("General Effect — % through season"); tooltip
  already renders the resolved `value`, only the heading text changes.

## Companion change: roster filtering (only corps competing that season)

Independent of captions, but requested together. Today both corps-search columns
list the **entire 248-corps directory** (mostly historical/defunct corps),
relying on the per-season grey-out to indicate who actually competed. For the
current season especially that's noisy. Restrict the lists to the corps relevant
to the selected season.

**Data — what "competing in 2026" means (verified):**
- The 2026 **prediction model** covers **59 corps** (the expected field) —
  `SELECT DISTINCT corps_key FROM model_event_prediction_rows r JOIN
  model_event_prediction_runs run … WHERE run.season='2026'`, surfaced in the
  read-model as **`SELECT DISTINCT corps_slug FROM rm_vs_corps_predicted`**.
- Only **10** corps have **scored** in 2026 so far (early season).
- **All 10 scored ⊆ the 59 predicted** (verified: 0 scored corps outside the
  model), so the prediction roster is a safe superset of "has performed."

**Behaviour:**
- **2026 prediction column** → list **only the roster** (the 59 with a predicted
  curve). A corps with no 2026 prediction can't add a predicted line anyway, so
  this is a pure filter (no grey-out needed here).
- **Corps-season column, season = 2026** → list **only the roster** (59, not 248);
  keep the existing availability **grey-out** *within* that set for corps that
  haven't performed yet (roster − scored ≈ 49 greyed, 10 active). This satisfies
  both the earlier "grey out who hasn't competed" ask and this "don't show
  irrelevant corps" ask.
- **Corps-season column, completed season (≤2025)** → list **only corps with
  scores that season** (`availabilityBySeason[season]`). They all have data, so no
  grey-out is needed there.

**Plumbing:**
- Extend the loader payload with a `roster2026: string[]` (distinct
  `rm_vs_corps_predicted` slugs) via a small reader/server-fn
  (`getVsActiveCorps` or fold into `getVsSeasonAvailability`).
- `CorpsSeasonColumn`: derive the visible set = `season === '2026' ? roster2026 :
  availabilityBySeason[season]`, filter `corpsOptions` to it; keep `isUnavailable`
  (grey) = roster member with no scores yet (2026 only).
- `PredictionColumn`: filter `corpsOptions` to `roster2026`.
- **Fallback:** if `roster2026` is empty (deep off-season before the model has
  run) OR `availabilityBySeason[season]` is empty (data hiccup), fall back to the
  full directory rather than showing an empty list — never strand the user.

**Edge cases / constraints for this part:**
- A corps in the 2026 roster but not yet performed has no actual line (greyed in
  corps-season) but **does** have a prediction line — consistent.
- The roster is derived from `rm_vs_corps_predicted`, so it only exists after a
  read-model emit that includes 2026 predictions (already the case). If 2026
  predictions are ever absent on prod, the fallback shows the full directory.
- Defunct corps that share a slug/alias with an active one are handled upstream by
  the prediction model's roster — we don't re-derive activeness from the `corps`
  table's stale `active` flag (unreliable).
- Search still works *within* the filtered set; typing a non-roster corps in the
  2026 view simply yields no match (expected).

## UX considerations

- **Placement & grouping.** One wrapping `FilterChips` row above the columns.
  Headline captions (`Total, General Effect, Visual, Music`) first; the 8
  sub-captions after, optionally visually separated (a thin divider or a second
  line on `sm+`). Mobile: the row horizontally scrolls (FilterChips already does
  this), so it doesn't crowd the tab bar below.
- **Switching caption keeps everything.** Series, scroll, and added-state persist
  across a caption change (it's an in-place search update). Only the plotted
  values + Y-scale change. The Y-axis is already `domain={['auto','auto']}`, so
  going Total (~60–98) → CG (~12–20) self-rescales smoothly.
- **Empty states.** If the active caption has no data for *any* current series
  (e.g. an all-2014 comparison on a sub-caption), show "No <caption> data for
  these series" rather than a blank chart. Per-series gaps just thin the lines.
- **Labels.** Pills use friendly labels (`Visual Prof.`, `Brass`) but the tooltip
  and axis can use the fuller name. Keep `Brass`/`Percussion` (not `MB`/`MP`) for
  non-fans, matching `RANK_METRIC_LABELS`.
- **Discoverability.** Default stays Total, so nothing changes for existing users
  until they touch the pills. The section's intro line gains "— compare any
  caption" so the control is explained.

## Assumptions

1. Caption is a **global** filter (one per comparison), not per-series. (Per-series
   captions would explode the legend and the URL; not requested.)
2. The 8-caption + 3-category + total tree is the complete, stable taxonomy for
   modern DCI (2015→). Verified: those are the only high-count rows in
   `caption_scores`/`category_scores`; everything else is parser noise (low counts).
3. `foldRecapRows` is the canonical, correct caption math (it backs the live recap
   table and rankings) — we do **not** re-derive caption sums from raw rows.
4. Predicted captions exist for every 2026 prediction run (`predicted_captions_json
   NOT NULL` in schema). Categories come from dedicated columns, not the JSON.
5. Re-emit is the only deploy step for the data half; app changes deploy normally.

## Edge cases

- **Sparse/old captions.** Pre-2015 and the occasional show lack sub-caption
  panels → null columns → dropped points. A corps season may have Total but no
  CG; that series simply has no line on the CG view. Tooltip/legend already handle
  missing points.
- **Category vs sub-caption scale mismatch in one chart is impossible** — all
  series share the single active caption, so they're always on the same scale.
- **Penalties.** `Timing & Penalties` is a category in the data but is a deduction,
  not a performance score — **excluded** from `VS_CAPTIONS`. (If ever wanted, it's
  a negative-going line and needs its own axis treatment.)
- **Baseline caption availability.** The V9 reference curves define all 8 captions
  for ranks 1–24; category sums and total are derived. No gaps expected.
- **Mis-categorized caption rows** (e.g. `caption_name='Color Guard'` tagged
  `category='Music'`, a handful of rows). `foldRecapRows` already normalizes via
  `caption_initials`/`normalizeCategoryKey`, so the fold is robust — don't bypass it.
- **In-progress 2026 `pct`.** The just-shipped `seasonPct` correction is applied in
  the same builders, so caption lines for 2026 also sit at the correct early-season
  position (not 0→100).
- **Old `?s=` links + new `cap`.** Absent `cap` = `total`; invalid `cap` →
  `total`. No migration needed.

## Constraints

- **Read-model is the request path on prod** — the chart half ships only after a
  full re-emit + A/B hot-swap (`refresh-prod-read-model.sh`). Until then prod
  serves the old (total-only) tables; the new columns just don't exist yet, so
  **land the builder/emit change and re-emit BEFORE (or with) the app change** —
  the resolver reading a not-yet-emitted column would throw (caught → empty
  series). Ship order: (1) builders + emit + re-emit prod, (2) app codec/resolver/UI.
- **No new scraping / modelling** — every value already exists; this is plumbing.
- **Effort-from-six-columns:** wide tables add ~11 columns to 3 small tables; the
  emit's VS section is the only schema touch.
- React Compiler is on (no manual memo); reuse `FilterChips`, `useSearchSync`-style
  in-place nav, and the rankings metric pattern rather than inventing new ones.

## Phasing

1. **Data:** widen builders + readers, fold captions, emit all 12; re-emit + verify
   parity locally; `refresh-prod-read-model.sh` to publish. (Backward-compatible —
   `total` still default, nothing visible yet.)
2. **Codec/types:** `captions.ts`, `cap` param, canonical omit-when-total.
3. **Resolver + loader:** caption-aware resolve; preview cache keyed by caption.
4. **UI:** FilterChips caption row + axis/heading labels.
5. **Polish:** grouping/divider, empty-state copy, tooltip caption label.

## Open questions (confirm before build)

1. Pill **grouping** — one flat row, or headline row + sub-caption row?
2. Sub-caption **labels** — `Brass`/`Percussion`/`Visual Prof.` (rankings-style) vs
   exact sheet names (`Music - Brass`)?
3. Should the **single-corps `/corps/[slug]`** VS card (the other consumer of
   `<VsChart>`) also get the caption pills, or is this `/vs`-only for now?
4. **Roster filter scope** — restrict the corps-season list for *every* season
   (to that season's competitors), or only collapse the noisy **2026** view and
   leave completed seasons showing the full directory? (Plan recommends the
   former: each season lists only its competitors.)
5. **Keep the grey-out** for 2026 roster-but-not-yet-performed corps (recommended,
   preserves the earlier ask), or hard-filter to only corps that have actually
   scored so far (10)?
