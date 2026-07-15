# Fantasy standings improvement plan

Date: 2026-07-15

Status: proposed — design complete, no code written yet.

Two features for the fantasy standings page (`app/routes/fantasy/$slug/standings.tsx`):

1. **Standings-over-time graph** — a rank/score-over-the-season chart at the top of
   the page, reusing the rankings-page bump chart, with league members as the
   series.
2. **Expandable standings rows** — each member row opens to show the corps they
   drafted, each pick's weight and caption value, and how those aggregate into the
   member's GE / Visual / Music subtotals and total.

Related:

- `docs/plans/RANKINGS_PAGE_PLAN.md` (the chart this reuses)
- `docs/plans/FANTASY_DCI_PLAN.md`, `FANTASY_UI_UX_IMPROVEMENT_PLAN.md`
- `app/components/rankings/rank-bump-chart.tsx` (`RankBumpChart`)
- `app/lib/fantasy/scoring.ts` (`computeRosterScore`), `app/lib/fantasy/standings.ts`
  (`buildStandings`, `buildBreakdown`)
- `app/lib/fantasy/services/standings-service.ts` (`getStandings`, `recompute`)
- `app/lib/fantasy/score-db.ts` (`getSeasonBestLookup`, `getDraftPool`)

---

## Current state (what exists today)

**Standings page.** `standings.tsx` loads `getStandings({ slug })` server-side (SSR
first paint), wraps it in a live `HybridCollection` so recomputes reflect without a
reload, reshapes each row via `toRecapRow`, and renders the shared
`ScoreRecapTable`. Each standings row already carries:

- `userId, rank, total, ge, visual, music`
- `perCaption: Record<CaptionKey, number>` (the 8 caption aggregates)
- `contributions: Record<CaptionKey, Array<{ corpsKey, value, weight }>>`
- `corpsName, corpsLogoMediaId, corpsColor, userName` — the member's **own fantasy
  identity** (their team name / uploaded logo), *not* the real corps they drafted.

**Scoring model** (`computeRosterScore`, `scoring.ts:51`). A member drafts corps,
each pick assigned to one of the 8 captions (`fantasy_picks`, with a deterministic
`weight` from `pickWeight(captionSlotIndex, …)` — set at draft, never mutated). Per
caption, the aggregate is a weight-normalized average over *scored* picks only
(`v ≤ 0` = not-yet-scored, excluded as missing data):

```
perCaption[k] = Σ(vᵢ·wᵢ) / Σ(wᵢ)          (or Σ(vᵢ·wᵢ) in 'sum' mode)
geRaw     = GE1 + GE2                       (≤ 40)
visualRaw = (VP + VA + CG) / 2              (≤ 30)
musicRaw  = (MB + MA + MP) / 2              (≤ 30)
ge/visual/music = raw · (categoryWeight / default)   default = 40/30/30
total     = ge + visual + music
```

`vᵢ` = the corps' **season-best** in that caption (`getSeasonBestLookup`, a single
`MAX(score)` grouped over the whole season, no date filter). Standings are ranked
`total desc, ge desc, music desc`.

**Recompute** is event-driven: `auto-ingest-scores.sh` POSTs
`/api/fantasy/jobs/recompute` within minutes of each show's recap landing (not a
fixed cron). It UPSERTs `fantasy_standings` (PK `league_id, user_id`) **in place** —
a pure function of picks × season-best × weights.

**The load-bearing gap for the graph:** `fantasy_standings` has **no time
dimension**. It is always a current snapshot; each recompute overwrites the prior
value. There is no per-show history to plot. But the *underlying* corps score data
(`caption_scores` + `competitions.date`) is fully dated, so a time-series is
reconstructable (see Feature 1).

---

## Feature 1 — Standings-over-time graph

### Goal

At the top of the standings page, a chart tracking each league member across the
season, with two modes:

- **Rank mode** (default) — a bump chart of each member's *place within the league*
  over time. Answers "am I climbing or falling?"
- **Score mode** — each member's fantasy *total points* over time.

X-axis = the season's competition dates (the shows that actually moved scores).

### Why the rankings chart is a near-perfect fit

`RankBumpChart` already does everything we need and is decoupled from rankings
except for two field names and a color source. Its props:

```ts
{ rows: RankRow[]; dates: string[]; hoveredSlug?; onHover?; height?; mode?: 'rank'|'score' }
```

It only reads `corpsSlug, corpsName, colorPrimary, colorSecondary,
history: {date, rank, score}[]` off each row. It is recharts-based, **lazy +
SSR-guarded** (renders an empty `h-80` placeholder until mounted, so it adds nothing
to the SSR payload and causes no CLS), caps at `RANK_SERIES_CAP = 18` lines
(fantasy leagues are smaller, so all members show), and already supports
hover-highlight, a rank/score toggle, zoom/pan, and a leader-sorted tooltip.
`corpsPalette` accepts an arbitrary `{ primary, secondary }`, so member colors work.

### The data problem and the chosen solution

No standings history is persisted. Two ways to get a time-series:

- **(a) Snapshot table**, written going forward by the recompute job. Faithful to
  whatever weights/picks were live at each show. No backfill — only captures shows
  after it ships.
- **(b) Retroactive reconstruction** from dated underlying scores: "member score as
  of date X" = the season-best query with `AND c.date ≤ X`, fed through the existing
  `buildStandings`. Iterate the season's distinct competition dates → one point per
  show. Reuses 100% of the scoring math. Reconstructs with *current* picks/weights.

Because weights are deterministic and never mutated after the draft, (b) is faithful
for the weight scheme; the only unfaithfulness is if a member's **roster** changed
mid-season (trades/waivers — confirm whether the league format allows this). Given
that, the plan is **both**:

> Add a `fantasy_standings_history` table (correctness going forward) **and** a
> one-time backfill using (b) so the graph is populated immediately for existing and
> past leagues.

### Data model

New table in `contributions.db` (`app/lib/contributions-db.ts`):

```sql
CREATE TABLE IF NOT EXISTS fantasy_standings_history (
  league_id               TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  through_competition_slug TEXT NOT NULL,   -- the show this point reflects
  as_of_date              TEXT NOT NULL,    -- competitions.date (YYYY-MM-DD) — x-axis
  rank                    INTEGER NOT NULL,
  total_score             REAL NOT NULL,
  ge_score                REAL NOT NULL,
  visual_score            REAL NOT NULL,
  music_score             REAL NOT NULL,
  computed_at             TEXT NOT NULL,
  PRIMARY KEY (league_id, user_id, through_competition_slug)
);
CREATE INDEX IF NOT EXISTS idx_fsh_league_date
  ON fantasy_standings_history (league_id, as_of_date);
```

Keying on `through_competition_slug` (not `computed_at`) means the several
recomputes that fire for one show all collapse to a single point — idempotent, one
row per member per show.

### Write path

- **Going forward:** in `StandingsService.recompute`, after computing each member's
  row, also `INSERT … ON CONFLICT(league_id, user_id, through_competition_slug) DO
  UPDATE` into `fantasy_standings_history`. `recompute` already computes every field
  and already knows `through_competition_slug`; resolve `as_of_date` from that
  competition.
- **Backfill script** (`sdk/scripts/backfillFantasyStandingsHistory.ts` or an
  `app/lib/fantasy` one-off): add `getSeasonBestLookupAsOf(season, date)` alongside
  `getSeasonBestLookup` (same query + `AND c.date ≤ date`). For each league, for each
  distinct competition date in the season, recompute standings with current picks
  and upsert the history rows. Guard: skip dates before the league's draft completed.

### Read path

New `StandingsService.getStandingsHistory(slug)` (parallels `getStandings`): returns
`{ dates: string[], series: Array<{ userId, name, color, points: {date, rank, score}[] }> }`.
A thin server fn `getStandingsHistory` exposes it.

### Chart integration

Two options; recommend starting with the adapter and generalizing only if a second
consumer appears:

- **MVP — adapter (no chart edits).** Map the history payload to the `RankRow`
  contract: `corpsSlug ← userId`, `corpsName ← corps_name || userName`,
  `colorPrimary ← corps_color`, `history ← points`. Pass `dates`. Render
  `<RankBumpChart rows={adapted} dates={dates} mode={mode} hoveredSlug onHover />`
  inside `<Suspense>`, lazy-imported exactly like rankings.tsx. Add a rank/score
  `ToggleGroup` mirroring the rankings route.
- **Cleaner — generalize later.** Extract a `TimeSeriesLineChart` taking
  `series: { key, name, color, points: {date, value}[] }[]` + formatters, with
  `RankBumpChart` becoming a rankings-specific wrapper. Modest refactor; do it only
  if fantasy is a second real consumer.

### Interaction tie-in

Lift `hoveredSlug`/`onHover` to the standings page and share it between the chart
and the table (hover a member's table row → their line highlights, and vice versa) —
the same bidirectional pattern rankings uses between its chart and list. This makes
the chart and the (now expandable) table feel like one surface.

### Edge cases

- **< 2 competition dates** (early / preseason): the chart is degenerate — hide it
  behind a "not enough shows yet" state until ≥ 2 dated points exist.
- **Off-season / empty league:** render nothing (same guard as the weekend
  carousel).
- **Member joins after some shows / incomplete roster:** their line starts at the
  first date they had any scored pick; leave earlier points null (recharts skips
  gaps).
- **Rank ties:** inherit rankings' deterministic tiebreak (`total desc, ge, music`).
- **Roster changed mid-season:** backfilled points use current roster — document
  this; if trades exist, prefer the going-forward snapshot as the source of truth
  and mark backfilled points as reconstructed.

---

## Feature 2 — Expandable standings rows (pick breakdown)

### Goal

Click a member's row to reveal the corps they drafted, with real corps logos, each
pick's caption / season-best value / weight, and a clear picture of how those roll
up into the member's GE / Visual / Music subtotals and total.

### What we already have vs what's missing

- **Already in the `getStandings` payload (no extra fetch):** `contributions` =
  `Record<CaptionKey, Array<{ corpsKey, value, weight }>>` — every picked corps'
  key, its caption value (`vᵢ`), and its weight (`wᵢ`), grouped by caption. Plus
  `perCaption`, `ge/visual/music`, and `total`. This is the entire arithmetic.
- **Missing:** `contributions` carries only `corpsKey` — not the real corps' **name
  or logo**. (The row's `corpsName`/`corpsLogoMediaId` are the member's own team
  identity, a different logo system.) Real corps identity lives in the score DB and
  is surfaced by `getDraftPool(season)` → `{ corpsKey, name, slug, corpsLogo,
  corpsLogoDark, corpsLogoDarkUrl }`.

### Resolving corps identity — chosen approach

Fetch `getDraftPool(season)` once on the standings page (it's small, already cached,
already used by the draft UI), build a `corpsKey → { name, slug, logo }` map, and
resolve on expand. Fetch it lazily on the *first* row expansion so it never touches
the initial load.

- **Rejected alternative:** denormalizing name+logo into `breakdown_json` at
  recompute. It bloats the standings payload for data only needed on expand, and
  goes stale when a corps logo changes (needs a recompute to refresh). Keep
  `breakdown_json` lean; resolve identity at read time.
- Real corps logos render through the normal corps-logo pipeline
  (`CorpsLogo`/`proxiedImage`) — note the recent `proxiedImage` fix so same-origin
  media URLs aren't double-proxied.

### Layout — mirror the scoring math

The scoring is caption-based, captions grouped into three categories, so the
breakdown reads top-down as the formula itself:

```
▼ 3rd · Blue Rims (member)                          total 92.40
  ┌ General Effect — 36.80 ────────────────────────────────────┐
  │  GE1   [logo] Blue Devils        19.4  × w1.0   → 19.40      │
  │  GE2   [logo] Bluecoats          17.4  × w1.0   → 17.40      │
  │        GE1 + GE2 = 36.80                                     │
  ├ Visual — 28.05 ─────────────────────────────────────────────┤
  │  VP    [logo] Carolina Crown     19.1  × w1.0   → 19.10      │
  │  VA    [logo] Boston Crusaders   18.6  × w1.0   → 18.60      │
  │  CG    [logo] Blue Knights       18.4  × w1.0   → 18.40      │
  │        (VP + VA + CG) / 2 = 28.05                            │
  ├ Music — 27.55 ──────────────────────────────────────────────┤
  │  … MB / MA / MP …            (MB + MA + MP) / 2 = 27.55       │
  └─────────────────────────────────────────────────────────────┘
```

- **One corps per caption is the common case** (a roster fills 8 caption slots).
  When a member has **multiple corps in one caption**, show each corps line and the
  `Σ(v·w)/Σ(w)` weighted-average rollup for that caption — the general form handles
  both.
- Weight is shown per row; when all weights are 1.0 (no reverse-weighting), collapse
  the `× w` column to reduce noise and show it only when weights differ.
- **Not-yet-scored picks** (`v ≤ 0`, excluded from the average): show the corps
  greyed with a "not scored yet" tag so the member sees their roster is complete but
  pending — don't silently omit them.
- Optional flourish: a thin stacked bar under the total showing each category's
  share (GE 40 / Visual 30 / Music 30 cap), to make "how they add up" visual.

### Table integration — opt-in, don't disturb prediction pages

`ScoreRecapTable` is shared with the prediction recap pages, so the expansion must
not leak there. Add **optional** props, defaulted off:

```ts
expandable?: boolean;
renderRowDetail?: (row: RecapRow) => React.ReactNode;
```

When `expandable`, render a disclosure affordance (chevron) in the name cell and, on
open, a full-width detail `<tr>` spanning all columns rendering `renderRowDetail`.
Prediction pages pass neither prop and are byte-for-byte unchanged. (Fallback if the
shared component proves too tangled: a standings-specific table fork, matching the
existing `full-recap-table-static.tsx` precedent — but the opt-in prop is preferred
for less duplication.)

The standings page owns `renderRowDetail`, building it from `row.contributions` +
the `corpsKey → identity` map. Multi-open accordion (no single-open constraint);
expansion state is local page state keyed by `userId`.

### Data flow summary

- Contributions/values/weights/subtotals: **already loaded** — zero new fetch.
- Corps identity (name/logo): `getDraftPool(season)`, fetched **lazily on first
  expand**, cached for the page.
- Rendering: real corps logos via `CorpsLogo`; the arithmetic is a pure transform of
  data already in hand.

### Edge cases

- **Missing corps identity** (key not in draft pool — data drift): fall back to the
  raw `corpsKey` as text, no logo, don't crash the row.
- **Empty roster / no contributions:** show "No picks yet."
- **`sum` scoring mode** (unbounded): show `Σ(v·w)` per caption instead of the
  average, matching `computeRosterScore`'s branch — read the league's
  `config.scoringMode` and render the matching formula so the breakdown always
  reconciles to the displayed total.
- **Reconciliation guard:** the sum of the rendered breakdown must equal the row's
  `total` to the cent — add a dev-only assertion so UI arithmetic can't silently
  drift from `computeRosterScore`.

---

## Phasing

**Phase 1 — Expandable rows (ships first; no schema/data work).**
All data except corps identity is already in the payload; identity is an existing
lazy fetch. Lowest risk, immediate value.
1. Add `expandable` + `renderRowDetail` opt-in props to `ScoreRecapTable`.
2. Lazy `getDraftPool` on first expand; build `corpsKey → {name, slug, logo}` map.
3. Standings-page `renderRowDetail`: category → caption → corps breakdown with the
   scoring-mode-aware formula and the reconciliation assertion.

**Phase 2 — History data model + backfill.**
1. `fantasy_standings_history` table.
2. Write history rows from `recompute`.
3. `getSeasonBestLookupAsOf` + backfill script; run for the active 2026 league(s).

**Phase 3 — The chart.**
1. `getStandingsHistory` service + server fn.
2. Adapter → `RankBumpChart`, lazy under `<Suspense>`, rank/score toggle.
3. Shared `hoveredSlug` between chart and expandable table.

---

## Testing

- **Scoring reconciliation:** unit test that the expandable breakdown sums to
  `computeRosterScore`'s `total`/`ge`/`visual`/`music` for both `avg` and `sum`
  modes, including multi-corps-per-caption and unscored-pick cases.
- **Backfill correctness:** the last (latest-date) reconstructed history point must
  equal the current `fantasy_standings` snapshot for every member of a league (they
  use the same math with `date ≤ today`).
- **History idempotency:** two recomputes for the same show produce one row per
  member (PK collapse), not two.
- **No-leak:** prediction recap pages render identically with the new optional
  `ScoreRecapTable` props absent (snapshot/visual check).
- **SSR/perf:** the chart stays out of the SSR payload (mount-guard) and the draft
  pool is not fetched until a row is expanded — verify no added initial-load
  requests via the smoke tester.
- **Edge:** < 2 dates hides the chart; missing corps identity degrades gracefully;
  empty roster.

## Open questions (confirm before Phase 2)

- **Roster mutability:** can a member's picks change after the draft (trades /
  waivers)? If yes, backfilled points are reconstructed with the *current* roster —
  mark them as such and treat the going-forward snapshot as authoritative. If no
  (draft-locked), the backfill is exact.
- **Which axis is the default** — rank (place in league) or score (points)? Plan
  assumes rank, matching the rankings default and the "am I winning" intent.
