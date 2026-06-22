# /rankings Page — implementation plan

Status: planned (2026-06-22). Not started. Research verified against the codebase + DB.

## Goal

A `/rankings` page: a season standings/leaderboard that combines a **bump-chart
graph** (rank position over the season) on top of an **animated, reorderable list**
of corps. Fully filterable, with **all state in query params** for shareable links,
defaulting to the current season's live standings. Built to match the project's
style (motion, OKLCH CSS vars, dark-mode-aware logos, corps colors, base-ui).

## Key design decisions (confirmed with product)

1. **Graph = bump chart of RANK position.** Y = finishing rank (1 at top, inverted
   axis), X = **competition dates**. Lines cross as corps overtake each other. Each
   line uses the corps's color; dark-mode-aware. This is distinct from the VS / corps
   score chart (which plots *score*) — here we plot *standing*.
2. **As-of axis = competition dates.** The scrubber steps through the actual show
   dates of the selected season; "as of date X" = standings computed from shows
   on/before X. One season at a time (not the VS %-through axis).
3. **Default = current season, "Highest score so far (Total)".** Season-best total
   per corps — the existing `buildSeasonStandings` behavior. Switchable to **"Average
   of last 3 shows."**
4. **Single-select ranking metric.** One of Total / GE / Visual / Color Guard /
   Brass / Percussion (default Total). The whole page (list order, graph, score
   shown) reflects the chosen metric.
5. **Group by Overall or Division** — same control + grouping logic as the recap
   table (`Overall` vs `Group by Class`).
6. **Recency indicator** — corps that haven't performed recently are visually
   de-emphasized (lowered opacity + a badge / colored marker showing "last performed
   N days ago"). The day-interval thresholds are a **customizable setting** (and live
   in the URL so a shared link reproduces them).
7. **Animated reorder** — list rows and graph re-animate/reorder when filters change
   (motion `layout` + `AnimatePresence`).
8. **Mobile horizontal-scroll as-of scrubber**; desktop gets prev/next arrow buttons
   matching the existing carousel pattern.

## Data realities (VERIFIED against the codebase + sdk/dci-relational.db)

- **No "as-of date" ranking API exists**, but the data fully supports it. Two routes:
  - **Fresh SQL (recommended):** join `corps_scores → competitions`,
    `WHERE season=? AND comp.date<=? AND scores_released=1 AND total_score IS NOT NULL`,
    `GROUP BY corps_key` with the chosen aggregate, order desc. `competitions` carries
    `date`, `day_of_season`, `percent_through` for all seasons. Caption/category scores
    join from `caption_scores`/`category_scores`. (`relational.ts:342,469-505`,
    view `corps_competition_results` `relational.ts:1235`.)
  - **Precomputed timeline:** `buildSeasonRankings` (`sdk/src/ranking.ts`) already emits
    one cumulative **best-score-so-far** snapshot per competition day, per metric,
    persisted in `season_rankings`/`season_ranking_entries` (queried via
    `relationalQueries.ts:143`). Free for the "highest so far" + bump-chart timeline;
    fixed to that aggregation rule, so **"avg of last 3" still needs the fresh-SQL path.**
- **"Highest score so far": exists** (`buildSeasonStandings` `MAX(total_score)`,
  `home.ts:123`; and `applyRanking` in ranking.ts). **"Avg of last N shows": does NOT
  exist** — build from raw `corps_scores` rows (windowed by date). Early season may
  have <3 shows → fall back to avg-of-available, and surface that.
- **Caption metric → fields** (reuse, do NOT reinvent): `recap.ts foldRecapRows`
  prefers published `category_scores` (GE/Visual/Music) and falls back to caption math
  `GE=GE1+GE2`, `Visual=(VP+VA+CG)/2`, `Music=(MB+MA+MP)/2`, total prefers published
  `total_score`. Caption keys: CG=Color Guard, MB=Brass, MP=Percussion
  (`recap.ts:65-200`). The metric selector maps Total/GE/Visual/Guard/Brass/Perc onto
  these. NOTE: list "Guard/Brass/Perc" are single captions (CG/MB/MP); "GE/Visual/Music"
  are categories — keep the mapping explicit.
- **Division/class**: per-event `corps_scores.division_name` (free text "World Class"
  etc.); grouping helpers `recapGroup`/`RECAP_GROUP_ORDER`/`RECAP_GROUP_LABELS`,
  `divisionCategory`, `classShortName` in `app/lib/prediction-scenario.ts:358-408`.
  Canonical order `CORPS_DIVISIONS` (`corps.ts:97`).
- **Logos**: `corpsLogoSource(corps)` → `<CorpsLogo>` (`app/components/corps-logo.tsx`).
  Dark handled via Tailwind `.dark` swap (SSR-safe, no theme JS). Never branch on theme.
  Dark predicate `app/predicates/corps.ts:15`.
- **Colors**: `corpsPalette(colors, mode)` (JS, for graph series — see
  `corps-score-chart.tsx:151-157`) or `corpsPaletteVars(colors, mode)` to scope
  `--corps-*` vars on a row. Brand fields `color_primary`/`color_secondary`. Read theme
  via `useSelector(themeStore, s => s.context.theme)` (`theme-store.ts`).
- **Reorder animation**: `StaggeredGrid` (`animateLayout`, `animationKey`) or its
  `motion.div layout` + `<AnimatePresence mode="popLayout">` pattern. Import `motion`
  directly from `motion/react` (barrel drops it under SSR — `app/lib/motion.ts:9`).
  Pass `initial={false}` on SSR-rendered motion roots.
- **As-of scrubber**: copy `ShopSection` (`app/components/shop/shop-section.tsx`)
  mechanics — `edges` state, `scrollByPage`, `ResizeObserver`, desktop-only arrows
  (`hidden sm:flex`), `.carousel-scrollbar snap-x`. Pills via `FilterChips`(`wrap={false}`)
  / `SeasonChips` (`app/components/filter-chips.tsx`).
- **State machine to copy**: `scoreTableMachine` (`app/machines/score-table-machine.ts`)
  — the generic, data-agnostic filter/sort/group machine (not the heavier
  `prediction-machine.ts`). Its `scoreTableSearchCodec` + `useSearchSync`
  (`app/lib/use-search-sync.ts`) is the URL-sync template. Wiring example:
  `app/components/prediction/past-season-scores.tsx:104-215`.
- **effect/Match + effect/Predicate** are the house style for dispatch/guards:
  `app/lib/merch-filtering.ts:22` (sort dispatch), `app/lib/judge-filtering.ts:34`
  (Match+Predicate), `app/predicates/prediction.ts`, `recap-head-cells.tsx:49`.
  Use `Match.value(metric).pipe(Match.when(...), Match.exhaustive)` for the metric→field
  resolver and the aggregation-mode dispatch; `Predicate` for recency/release guards.

## URL / query params (all state shareable)

Route `validateSearch` + a `SearchCodec`, defaults omitted (canonical URLs):

- `season` — default = current season (omitted when current).
- `asof` — competition date `YYYY-MM-DD`; omitted = latest (current standings).
- `metric` — `total`(default)|`ge`|`visual`|`guard`|`brass`|`perc`.
- `agg` — `best`(default)|`last3`.
- `group` — `overall`(default)|`division`.
- `div` — included divisions (comma-list, e.g. `world,open`); default = world+open
  (matches `buildSeasonRankings` default). Reuse the comma-list convention.
- `recency` — customizable day thresholds, compact (e.g. `7,14,28`); omitted = defaults.

## Series / data model

`app/lib/rankings/types.ts`:

```ts
type RankMetric = 'total'|'ge'|'visual'|'guard'|'brass'|'perc';
type RankAgg = 'best'|'last3';
type RankRow = {
  corpsSlug: string; corpsName: string; division: string;
  score: number; rank: number;            // rank within current group/scope
  lastPerformedDate: string;              // for recency indicator
  daysSinceLast: number;
  // graph: per-show rank history up to asof
  history: { date: string; rank: number; score: number }[];
};
```

Resolver computes, for the chosen season/asof/metric/agg/div: each corps's aggregated
score, its rank (recomputed within group when grouped), recency, and the rank-history
needed for the bump chart (one rank-snapshot per competition date ≤ asof).

## Milestones (commit each)

### M1 — Rankings resolver (server)
- `app/lib/rankings/resolve.ts` + server fn/RPC `getRankings({season,asof,metric,agg,div})`.
- `best` path: prefer precomputed `season_ranking_entries`; else fresh SQL `MAX`.
- `last3` path: fresh SQL windowed avg of last ≤3 shows by date (fallback <3, flagged).
- Bump-chart history: per competition date ≤ asof, the rank of each corps under the
  current metric/agg (this is the per-date standings sequence).
- Metric→field + agg-mode dispatch via `Match`; release/recency guards via `Predicate`.
- Read-model preferred on serve host; relational/builder fallback. Cache per param set.

### M2 — Rankings list (animated, reorderable)
- `app/components/rankings/rankings-list.tsx`: rows = rank badge + `<CorpsLogo>` +
  name (link to `/corps/$slug/{season}`) + score + caption/metric value + recency
  indicator. `motion.div layout` + `<AnimatePresence mode="popLayout">`, `animationKey`
  = `${season}|${asof}|${metric}|${agg}|${group}`. Division section headers when grouped
  (reuse `recapGroup`/`RECAP_GROUP_ORDER`).
- Recency indicator: opacity ramp + badge ("perf. 12d ago") + colored marker, driven by
  the `recency` thresholds; thresholds editable in a small settings popover (base-ui),
  persisted to `recency` param.
- Per-row corps hue via `corpsPaletteVars` scoped on the row (light + `.dark`).

### M3 — Bump chart (graph view)
- `app/components/rankings/rank-bump-chart.tsx`: Recharts `LineChart`, **Y reversed**
  (rank 1 at top), X = competition dates, one `<Line>` per corps in `corpsPalette(...).chart`.
  Highlight on hover/row-hover (shared hover state with the list). Tooltip: corps, date,
  rank, score. SSR placeholder/`mounted` to avoid CLS. Re-animates on filter change.
- Cap plotted lines (e.g. top N + selected) with a visible "showing top N" note —
  no silent truncation.

### M4 — Controls + as-of scrubber
- Season pills (`SeasonChips`), metric single-select, agg toggle (`best`/`last3`),
  group toggle (`Overall`/`Division`), division multi-select (reuse the recap class-
  filter dropdown / `CaptionMultiSelect` pattern).
- As-of scrubber: `FilterChips wrap={false}` pills of competition dates inside a
  `ShopSection`-style scroller — mobile horizontal-scroll, desktop prev/next arrows
  (`hidden sm:flex`, `edges`/`scrollByPage`). Default selection = latest date.

### M5 — State machine + URL sync
- `app/machines/rankings-machine.ts` (model on `scoreTableMachine`): context =
  `{season,asof,metric,agg,group,div,recency, rows, history}`; events for each control
  + `SET_ROWS` + `SYNC`. Resolved data fetched via M1 on change (loader-seeded SSR,
  `fromPromise` for client refetch like prediction-machine).
- `app/lib/rankings/codec.ts` `SearchCodec` ⇄ the params above; `useSearchSync`,
  `replace:true`, `resetScroll:false`. Encode every key each pass so clearing removes it.

### M6 — `/rankings` route + page
- `app/routes/rankings.tsx`: `validateSearch`, loader resolves initial standings SSR
  (shareable). `PageShell`; graph on top, list below; controls bar. Default = current
  season current standings. Empty/off-season + loading/error states via `Match.value(status)`.
- Cross-links: rows → `/corps/$slug/{season}`; consider a link to the VS chart
  ("compare these") for selected corps.

### M7 — Polish
- Reduced-motion respected (global `MotionConfig reducedMotion="user"`); `initial={false}`.
- base-ui `Tooltip`s on metric/agg/group/recency controls and the recency badges.
- Tests: codec round-trip (defaults omitted), resolver as-of correctness (only shows
  ≤ asof), metric→field mapping, last3 fallback when <3 shows, rank recompute within group.
- Verify on current season (default), an as-of mid-season date, division grouping, and
  a non-Total metric.

## Edge cases
- Early season: <3 shows → `last3` averages what exists, flagged; bump chart has few points.
- Corps that competed once: single-point line; still ranks.
- Ties on score: stable secondary sort (e.g. by name) so reorder animation is deterministic.
- Division grouping changes rank numbering (within-group) — keep overall rank available
  for the graph/tooltip.
- as-of before a corps's first show: corps absent from that as-of standing (not rank 0).
- Released-flag: exclude unreleased/null scores (`scores_released`, `total_score IS NOT NULL`).
- Metric with missing caption data for some corps (e.g. exhibition) → exclude from that
  metric's ranking rather than score 0.

## Open questions (address later)
- Bump chart line cap N and whether to always include user-selected/favorited corps.
- Recency default thresholds + exact visual treatment (opacity ramp vs colored line vs badge — likely all three, tunable).
- Whether `last3` should be "last 3 shows" or "shows in last N days" — currently last-3-by-count.
- Should the graph offer an optional score-axis toggle later (out of scope v1; bump only).
- `/rankings` vs the home "Season standings" module — share the resolver; decide if home links here.

## Follow-ups (not v1)
- Score-axis toggle on the graph (rank ↔ score).
- Multi-caption column list view (richer table mode).
- Multi-season overlay (would switch graph X to %-through, reusing the VS axis).
- Movement arrows (▲▼ vs previous as-of) per row.
