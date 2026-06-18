# Full Recap — unified, animated, DCI-style judge breakdown

> Plan for replacing the separate "View full recap" section with a Full-Recap **mode**
> of the score table: toggled from the table header, transitioning/animating in place,
> and carrying the same sorting / grouping / rank features — laid out like dci.org
> (per-judge sub-columns with Rep·Perf / Cont·Achv + TOT, linked judges, penalties).

Status: **M1–M4 built + SSR + URL sort + crossfade transition** (typechecks clean,
all routes 200). Remaining: M5 upgrade (true cross-table row morph — currently a
crossfade; see §7 note) and M6 polish/verification on more events. Target event for
manual
verification: `/events/2024/2024-the-buccaneer-classic/prediction` (12 corps, full
data present: 8 judge assignments, 64 judge scores, 164 subcaptions).

---

## 1. Goals

1. **Move the Full-Recap toggle into the score-table header toolbar** (alongside
   Ranges / Sort-mode / Group-by-class), not a detached pill below the card.
2. **Seamless transition** between the compact recap and the full recap — the table
   expands in place; corps rows keep their identity and slide; caption cells expand
   into their per-judge sub-columns rather than the whole block popping in/out.
3. **Feature parity across both modes**: column **sorting**, class **grouping**
   (section header rows), and **ranks** (the small rank subscript under each value)
   all work in the full recap exactly as they do in the compact one.
4. **DCI-faithful layout** (matches the provided dci.org markup):
   - Category band (General Effect / Visual / Music) spanning its captions.
   - Per caption: caption name → **judge name** → sub-label row (`Rep` `Perf` `TOT`
     for GE, `Cont` `Achv` `TOT` for Visual/Music — labels come from the data, see
     §4.4).
   - Category **Sub** total column, **Sub Total**, **Penalties**, **Total**.
   - Every leaf cell shows score + rank subscript (DCI shows `9.700` over `3`).
5. **Judges are links** to `/judges/$judgeId`.
6. **Every sub-column is independently sortable** (full DCI parity — DCI's
   `sortTable(0..39)`): each judge's Rep/Perf/Cont/Achv and TOT, each caption,
   each category subtotal, Sub Total, Penalty, Total.

### Non-goals (this iteration)

- Score **ranges** in the full recap (ranges are a forecast feature of the compact
  prediction table; the full recap is released, point-valued data). The Ranges
  toggle stays hidden in full mode.
- Persisting full-recap sort state in the URL (machine-only for now; see §11 Open
  questions — can be a fast follow).
- Rewriting the compact table's internals. It stays as-is; we add a sibling mode.

---

## 2. Success criteria

A change is "done" when, on the target event:

- [ ] The Full-Recap toggle lives in the table header; toggling flips `?recap=full`
      and animates the table between compact and full in place (no detached section,
      no layout jump, no flash).
- [ ] In full mode the header renders: category band → caption → linked judge →
      `Rep/Perf|Cont/Achv` + `TOT` sub-labels, then `Sub`, `Sub Total`, `Penalties`
      (only if any corps has a penalty), `Total`.
- [ ] Clicking any leaf header cycles its sort `none → desc → asc → none`; exclusive
      and stack modes behave like the compact table; the active arrow + priority
      badge render identically (reuse `SortableScoreHeader` styling).
- [ ] Group-by-class inserts the same section header rows in full mode; ranks are
      computed **within the group** when grouped, **overall** when not — matching the
      compact table's `rankWithinGroup` / `overallPointRanks` behaviour.
- [ ] Every value cell shows the correct score and a rank subscript that recomputes
      under filtering/grouping/sorting.
- [ ] Bushwackers (and the 34 other dup-identity cases) appear **once** (dedupe from
      the builder is already in place — `buildEventFullRecap`).
- [ ] Judge names navigate to `/judges/$judgeId`.
- [ ] `vp check` (app) and `npx tsc -p sdk/tsconfig.json` (diff vs baseline) are clean.
- [ ] SSR renders the page at 200 with the full table when `?recap=full` is set
      (it's lazily fetched client-side today; see §8 — decide SSR vs lazy).
- [ ] Horizontal scroll works; the Corps column stays sticky; no `<table>` nesting
      validation warnings.

---

## 3. Current architecture (as explored)

- **Past-season page**: `app/components/prediction/past-season-scores.tsx`
  - Owns `scoreTableMachine` (`@xstate/react`), URL-synced via `useSearchSync` +
    `scoreTableSearchCodec`.
  - Renders compact `ScoreRecapTable`, then a **separate** "View full recap" pill +
    `AnimatePresence` height-collapse wrapping `FullRecapTable`.
  - Lazily fetches the full recap with `getHybridEventFullRecap({ data: slug })`
    into local `fullRecap`/`fullStatus` state (fetch dedup via `fullStartedRef` —
    recently fixed; do not reintroduce `fullStatus` as an effect dep).
- **Compact table**: `app/components/prediction/score-recap-table.tsx`
  - Header toolbar (Ranges / Sort-mode / Group / Clear) in `CardHeader`.
  - Body is a single `<Table>`; rows are `motion.tr` keyed by `corps` with
    `layout="position"` (no `layoutId` — removed; redundant + caused ghost rows).
  - Derivations: `visibleRows` (class filter) → `sortedRows` (multi-sort) →
    `recapSections` (group) → `rankWithinGroup` (per-section ranks) +
    `overallPointRanks` (ungrouped ranks) + `captionRanks` (per-column subscript).
  - Headers use `SortableScoreHeader` (`app/components/prediction/score-header.tsx`).
- **Full table (to be replaced)**: `app/components/prediction/full-recap-table.tsx`
  - Static, non-interactive. Collapses each caption's judges into one tiny text line.
  - Column model `captionColumnsOf` derives from the "richest" corps.
- **State machine**: `app/machines/score-table-machine.ts`
  - Context: `rows, classFilters, sortMode, sorts, showRanges, groupByClass,
    groupTouched, showFullRecap`. Events incl. `SET_SHOW_FULL_RECAP`, `CYCLE_SORT`,
    `SET_SORTS`, `SET_GROUP_BY_CLASS`, `SYNC`. Codec round-trips `?recap=full`.
- **Data source**: `buildEventFullRecap` (`sdk/src/readModel/builders/fullRecap.ts`)
  returns `{ meta, corps: FullRecapCorps[] }` where each corps has
  `categories[].captions[].judges[].subcaptions[]`, plus `subtotal`, `penalty`,
  `total`, ranks at every level. Already dedupes dup corps identities.
- **Server fn**: `getHybridEventFullRecap` (`app/lib/server-fns/hybrid.ts`) → DB-backed
  fallback in dev, read-model in prod.
- **Judge route**: `/judges/$judgeId` exists (`app/routes/judges/$judgeId.tsx`);
  `judgeId` matches `FullRecapJudge.judgeId`.

---

## 4. Target design

### 4.1 Component shape — centralize both modes in `ScoreRecapTable`

Make `ScoreRecapTable` own the **toolbar + both bodies** so the toggle, grouping,
and transition are shared. The compact `<Table>` and the new full table render as
sibling bodies inside the same `Card`, swapped by `showFullRecap`.

New props on `ScoreRecapTable`:

```ts
// full-recap data + lazy status (owned by past-season-scores)
fullRecap: FullEventRecap | null;
fullStatus: 'idle' | 'loading' | 'error';
showFullRecap: boolean;
onToggleFullRecap: (next: boolean) => void;
// full-recap per-subcolumn sort (separate key space from compact `sorts`)
fullSorts: FullSortEntry[];
onCycleFullSort: (key: string) => void;
onSetFullSorts: (sorts: FullSortEntry[]) => void;
// for judge links + corps links inside the full table
yearSlug: string;
```

`FullRecapTable` is rewritten to a feature-complete interactive table and rendered
by `ScoreRecapTable` (it receives the shared grouping/rank/sort context). The old
detached pill + `AnimatePresence` block in `past-season-scores.tsx` is removed; that
file just wires the new props from the machine.

Rationale: a shared toolbar across modes and an in-place transition both require the
two bodies to live under one container. Keeping them in separate components rendered
far apart (as today) makes "seamless" impossible.

### 4.2 Leaf-column model (the heart of it)

Build a flat, ordered list of **leaf columns** once per `fullRecap` (memoized),
derived from the richest corps (most captions) so a partial top row never truncates
the table. Each leaf knows how to read its value from a corps and its stored rank:

```ts
type LeafKind = 'sub' | 'tot' | 'caption' | 'category' | 'subtotal' | 'penalty' | 'total';

interface LeafColumn {
  id: string;                 // stable sort key, e.g. "GE1:judge-123:Rep" / "cat:Visual" / "total"
  kind: LeafKind;
  label: string;              // "Rep" | "Perf" | "TOT" | "Sub" | "Total" ...
  // grouping metadata for the header bands:
  category?: string;          // "General Effect"
  caption?: string;           // "General Effect 1"
  captionInitials?: string | null;
  judge?: { id: string; name: string | null; initials: string | null; number: number | null };
  get: (c: FullRecapCorps) => number | null;       // value accessor
  storedRank?: (c: FullRecapCorps) => number | null; // DCI's printed rank (fallback)
}
```

Header is rendered from a **3-tier grouping** of these leaves:

- Tier 1 (category band): GE / Visual / Music (+ standalone Sub Total, Penalties,
  Total). `colSpan` = number of leaves under it.
- Tier 2 (caption + judge): one cell per judge per caption, spanning that judge's
  sub-columns (Rep/Perf/TOT = 3). Judge name is the link.
- Tier 3 (sub-labels): the sortable leaf headers (`Rep` `Perf` `TOT`, etc.).

Cells: one `<td>` per leaf per corps, `score` + rank subscript.

> Implementation note: prefer **CSS classes for column borders** (`border-l` at each
> category boundary) over nested `<table>`s. DCI nests tables; we should render a
> single `<table>` with `colSpan` header rows for valid semantics, sticky support,
> and so the morph (§7) has stable DOM to animate.

### 4.3 Sorting (all sub-columns)

- New key space: `FullSortEntry = { key: string; dir: 'asc' | 'desc' }` keyed by
  `LeafColumn.id`. Keep it **separate** from compact `sorts` (`RangeKey`) so neither
  view clobbers the other.
- Generalize the existing `cycleSort` into a key-agnostic helper
  `cycleSortGeneric<K>(sorts, key, mode)` (the current `cycleSort` becomes a thin
  `RangeKey` wrapper) and reuse it for both. Lives in `prediction-scenario.ts`.
- Sorting applies the active leaves' `get()` with the same exclusive/stack semantics
  and the missing-value-sinks-to-bottom + `rank` tiebreak rule as
  `score-recap-table.tsx`'s `sortedRows`.
- Headers reuse `SortableScoreHeader`'s **visual** (arrow rotation, priority badge,
  glow). Extract the inner button/arrow into a small `SortArrow` so both the
  `RangeKey` header and the generic leaf header share it without duplicating styles.

### 4.4 Sub-labels from data, not hardcoded

DCI shows `Rep/Perf` for GE and `Cont/Achv` for Visual/Music — but the source data
has these as `subcaption_scores.subcaption_name` / `subcaption_initials`. **Derive
the sub-label set per caption from the data** (union of subcaption initials across
judges, in stored order), with `TOT` appended for the judge total. Do **not**
hardcode Rep/Perf/Cont/Achv — older seasons and All-Age panels differ (note the
provided markup even shows `Comp` and `CONT` casing variants). Fall back to the judge
TOT-only column when a caption has no subcaptions.

### 4.5 Ranks

- **Subscript ranks recompute over the active scope** (visible rows; per-section when
  grouped), ties share the lower rank — same algorithm as compact `captionRanks`.
  Generalize that into `columnRanks(rows, getValue)` and run it per leaf.
- Corps **row rank** (sticky column): reuse `overallPointRanks` (ungrouped) /
  `rankWithinGroup` (grouped) by `total`.
- Prefer recomputed ranks for consistency with filtering/grouping. The data's
  `storedRank` is the fallback only when a value is present but unrankable.

### 4.6 Grouping

Reuse `recapGroup` + `RECAP_GROUP_ORDER`/`LABELS`. Section header rows span the full
leaf width (`colSpan={leaves.length + stickyCols}`). The compact `recapSections`
logic ports directly; factor the grouping into a shared helper taking
`(rows, groupByClass, classCount)`.

---

## 5. State machine changes (`score-table-machine.ts`)

Add to `ScoreTableContext`:

```ts
fullSorts: FullSortEntry[];
fullSortMode: SortMode;   // reuse compact sortMode? See note.
```

- Events: `CYCLE_FULL_SORT { key: string }`, `SET_FULL_SORTS { sorts }`.
- `cycleFullSort` action mirrors `cycleSort` using `cycleSortGeneric`.
- **Reuse `sortMode`** for both views (one Stack/Exclusive toggle governs whichever
  table is showing) — simpler UX and less state. The Stack/Exclusive toolbar toggle
  already shows only when there are active sorts; gate it on the active view's sorts.
- `showRanges` is forced off / hidden in full mode (don't change context, just hide
  the toggle and ignore the value when `showFullRecap`).
- Codec: leave URL as-is for now (machine-only full sort). If we later persist, add a
  `fsort` param mirroring `sort` (and matching coercion in
  `validatePredictionSearch`, per the codec⇄validateSearch contract in CLAUDE.md).

Keep `groupByClass`, `groupTouched`, `classFilters`, `showFullRecap` exactly as they
are — they already serve both modes.

---

## 6. Data flow & types

- `FullEventRecap` type continues to be derived on the client from the server fn
  return (`Awaited<ReturnType<typeof getHybridEventFullRecap>>`) so the client bundle
  never imports SDK internals. Export the row subtypes from one place
  (`full-recap-table.tsx`) and import into `score-recap-table.tsx` as needed.
- The leaf model + sort/rank derivations live in a small pure module
  `app/lib/full-recap.ts` (testable without React): `buildLeafColumns`, `sortCorps`,
  `columnRanks`, `groupCorpsByClass`. Keeps `FullRecapTable` thin/presentational and
  matches the "logic in lib, dumb components" convention.

---

## 7. Animation / transition strategy

The honest constraint: **a literal per-cell morph inside an HTML `<table>` is
fragile** — table layout (not the cells) controls column widths, which fights
Framer's transform-based `layout`. Plan in layers, each independently shippable;
stop at the level that looks good without jank.

1. **Container + rows (must-have).**
   - One `Card`; swap bodies with `showFullRecap`. Wrap the swap so width/height
     animate (Framer `layout` on the scroll container, or `AnimatePresence` with a
     measured height). Corps `motion.tr` keyed by `corps` persist across the swap via
     **`layoutId={corps}`** so each row slides to its new position instead of
     fade-replacing. (We removed `layoutId` from the compact-only table to fix ghost
     rows; re-introducing it here is correct **because** rows now cross a mode
     boundary — the exact case `layoutId` is for. Guard with `AnimatePresence` so
     there's a single presence context.)
2. **Caption cell expand (nice-to-have).**
   - Give the compact caption cell and the full caption's **TOT** column a shared
     `layoutId` (`${corps}:${caption}:tot`) so the single compact score visually
     "lands" as the caption total while the judge sub-columns fade/scale in around it
     via `AnimatePresence` + `initial={{opacity:0}}`. This reads as the cell
     expanding without a true per-sub-column morph.
3. **Header band reveal.**
   - Category bands and judge sub-headers animate in with a short stagger
     (`initial={false}` on SSR to avoid FOUC per the project's Motion guidance).

Guardrails:
- `useSuppressLayoutOnce` already exists to skip layout animation on the
  ranges↔scores flip; reuse the same pattern to skip layout on the **first** full
  render (so the initial open from `?recap=full` doesn't animate from a zero box).
- Respect `MotionConfig reducedMotion` (already set in `__root.tsx`).
- Horizontal width jump is large (≈1040px → several thousand px). Animate
  `height`/opacity, **not** width, to avoid a long horizontal scrub; let the wide
  table appear at full width inside the scroll container and animate the container's
  height + a cross-fade. This is the pragmatic "seamless" that survives 12 corps × 40
  columns.

If level 2/3 prove janky on real hardware, ship level 1 (rows persist + height/fade)
— it already satisfies "seamlessly transition" far better than today's pop-in.

---

## 8. SSR vs lazy fetch

Today the full recap is **client-lazy** (effect → `getHybridEventFullRecap`). With
the toggle in the header and `?recap=full` shareable, decide:

- **Option A (keep lazy):** simplest; full table fades in after mount. Loading state
  shows inside the expanding area. Transition still works (rows morph once data
  arrives).
- **Option B (loader):** add `fullRecap` to the route `loader` when `search.recap ===
  'full'` so a shared `?recap=full` link SSRs the full table (no spinner, better for
  sharing/SEO). Costs a heavier loader on that path only.

**Recommendation: A now, B as a fast follow.** Keep the lazy fetch (already fixed)
but make the loading/empty/error states render *inside* the table card so the
toolbar + sticky Corps column are present immediately.

---

## 9. Edge cases

- **Penalties:** only render the Penalties column when some corps has a non-zero
  penalty (compact `hasPenalty` logic). DCI prints `--` for none.
- **Partial panels (All-Age / older seasons):** caption/judge sets vary by corps;
  the richest-corps column model + per-corps `Map` lookups must render `—` for
  missing leaves (don't assume every corps has every judge).
- **Missing subcaptions:** judge has a TOT but no Rep/Perf — render TOT only; sub
  columns show `—`.
- **Judges without a profile / null name:** fall back to initials, then judge number;
  link only when `judgeId` resolves (it always exists in data, but guard the route
  param). Don't render an empty `<a>`.
- **Single class:** group toggle hidden (`classCount <= 1`), same as compact.
- **Ties:** shared rank (lower number) in both row rank and column subscripts.
- **Dedup identities:** handled in the builder; verify Bushwackers once.
- **Sort key collisions:** leaf `id`s must be unique even when two judges share a
  caption — include `judgeId` (and subcaption initials) in the id.
- **Very wide table on mobile:** sticky Corps column + horizontal scroll; ensure the
  sticky `z-index`/background match the compact table so rows don't bleed under it.
  Reuse `useStickyScroll`.
- **Hydration:** the table is data-driven and deterministic; no `Date.now()`/locale
  in cells. Keep number formatting via `fmt` (UTC-agnostic).
- **React Compiler:** no manual memo on components; keep heavy derivations in
  `useMemo` in the lib-backed hook or compute in the pure module and pass results in.
- **`<For>` vs `.map`:** sortable headers and data cells must use **`.map`** (not
  `jotai-solid-api` `<For>`) — `<For>` memoizes by item identity and freezes when the
  column array is constant, exactly the bug already documented in the compact table.

---

## 10. Milestones

> Each milestone is independently mergeable and leaves the page working.

- **M0 — Plan & scaffolding (this doc).** Add `app/lib/full-recap.ts` with the pure
  leaf/sort/rank/group helpers + unit-ish smoke (node/tsx) over the target event.
- **M1 — Toggle relocation.** Move the Full-Recap toggle into `ScoreRecapTable`'s
  toolbar; render the *existing* `FullRecapTable` inside the same card (no morph yet,
  no new features). Remove the detached pill from `past-season-scores.tsx`. Verify
  `?recap=full` still round-trips. (Pure refactor; low risk.)
- **M2 — DCI layout.** Rewrite `FullRecapTable` to the 3-tier header + per-judge
  sub-columns + Sub/Sub Total/Penalties/Total, scores + stored ranks, linked judges.
  Read-only (no sort/group yet). This is the bulk of the layout work.
- **M3 — Grouping + recomputed ranks.** Port `recapSections` + `columnRanks`; section
  header rows; ranks recompute over scope. Group toggle now affects full mode.
- **M4 — Sorting (all sub-columns).** `fullSorts` in machine; `cycleSortGeneric`;
  every leaf header sortable; Stack/Exclusive reuse; shared `SortArrow` visual.
- **M5 — Transition.** Animation levels 1→3 from §7, stopping where it stays smooth.
- **M6 — Polish & verify.** Edge cases (§9), mobile sticky/scroll, reduced motion,
  typecheck, manual verification on the target event + one multi-class + one All-Age
  event. Optional: URL persistence of full sort (B in §8).

---

## 11. Maintainability tips

- **One source of truth for derivations.** Put leaf-model/sort/rank/group logic in
  `app/lib/full-recap.ts` (pure, no React). Components stay dumb (render + emit
  events). Mirrors the project's XState/lib split and makes the logic testable.
- **Don't fork sort logic.** Generalize `cycleSort` once (`cycleSortGeneric`) and have
  both the `RangeKey` and leaf-key paths call it. Same for the rank algorithm
  (`columnRanks`) and the grouping (`groupCorpsByClass`) — share with the compact
  table where the shapes line up.
- **Extract `SortArrow`** from `SortableScoreHeader` so the arrow/priority/glow visual
  is defined once and reused by the leaf headers (avoid pixel drift between modes).
- **Keep the builder authoritative.** All scores/ranks/penalties/dedup come from
  `buildEventFullRecap`; the client only *projects* and *re-ranks for scope*. Never
  recompute totals client-side (published totals are authoritative — see the recap
  builder's note about partial panels).
- **Sub-labels are data-driven** (§4.4) — don't hardcode Rep/Perf/Cont/Achv.
- **Comment the `layoutId` reintroduction** with *why* (rows cross a mode boundary)
  so a future reader doesn't "fix" it back out like the compact-table ghost-row case.
- **Bump `SCHEMA_VERSION`** only if `rm_event_full_recap`'s shape changes — this work
  is read-side/projection only and should not need a schema bump or re-emit. If the
  builder *output* shape changes (e.g. new fields), bump it and re-emit per
  `READ_MODEL_PLAN.md`.

---

## 12. Verification

- `vp check` / `npm run check` (app) clean; `npx tsc --noEmit -p sdk/tsconfig.json`
  diffed against baseline (sdk has pre-existing errors).
- Manual (user confirms in-browser, per preference — no auto-launch):
  - Target event: toggle from header, watch the transition, sort several leaves
    (incl. a single judge's Rep), group by class, verify ranks + single Bushwackers,
    click a judge → profile.
  - A clean multi-class DCI event (World/Open/All-Age) for grouping.
  - An older/partial-panel event for the missing-leaf paths.
- Optional pure smoke: `npx tsx` over `buildLeafColumns(fullRecap)` for the target
  event asserting column count, unique ids, and that every corps resolves each leaf.

---

## 13. Decisions (resolved)

1. **Full-sort in URL: YES.** Persist via a `fsort` param (mirrors `sort`), with
   matching coercion in `validatePredictionSearch` and the `scoreTableSearchCodec`
   (keep encode/decode symmetric, omit when empty — per the codec⇄validateSearch
   contract in CLAUDE.md).
2. **Stack/Exclusive mode: shared** (`sortMode` governs whichever table is showing).
   Best-judgement call — one toggle, less state, matches the single-toolbar UX.
3. **Animation: go for the full morph first** (§7 levels 1→3, incl. caption-cell
   shared-id expand). Back off to level 1 only if it janks on real hardware.
4. **SSR the full recap: YES.** Route `loader` fetches it when `search.recap ===
   'full'` (via `loaderDeps`) and seeds the page; the client lazy fetch remains the
   fallback for toggling on after load.
