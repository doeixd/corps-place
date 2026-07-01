# Diff-basis toggle — "vs Prediction" / "vs Previous show"

Adds a toggle group above the prediction page's **Diff** table letting the user
choose what the diff is measured against: the corps's **prediction** (current
behaviour) or their **previous show's score**. Extends
`SCORES_PREDICTION_DIFF_TABS_PLAN.md`.

**Decisions locked in (product):**

1. **Per-corps semantics.** "Previous score" = _each corps's own most recent
   prior show this season_. The comparand event therefore differs per row (tour
   routing differs), so there is no single "previous event" label.
2. **All seasons.** Works wherever the Diff tab shows, including past-season
   pages that serve from the read-model → requires a new emitted read-model
   section, not just a live query.
3. **Decoupled fetch + prefetch-after-load.** A separate server-fn, not the
   blocking loader. The loader awaits it only when the URL deep-links
   `?diffbase=previous` (SSR-correct); otherwise an XState actor prefetches it in
   the background after paint so the first toggle is instant.

---

## 1. UX / interaction

**Control.** A 2-item single-select `ToggleGroup` (same component/variant as the
Scores/Prediction/Diff tab bar — `variant="outline" spacing={0}`) sits inside the
Diff view, directly above `DiffRecapTable`:

```
[ vs Prediction ]  [ vs Previous show ]
```

- Driven by machine state (`ctx.diffBase`), dispatches `SET_DIFF_BASE`.
- Rendered only when the Diff view is active **and** ≥2 bases are available.
  With a single available basis, render no toggle (optionally a static caption).

**Per-corps comparand — must be communicated** (there's no single previous event):

- **Cell tooltip** (extend the existing one): `Scored 91.200 · Previous 89.400 —
  DCI San Antonio, Jul 12 · Diff +1.800`. The prior event name + date come from a
  per-corps `sources` map returned alongside the rows.
- **Helper line** under the toggle in previous mode: _"Each corps vs its own most
  recent prior show this season."_
- Corps with **no** prior show (season openers, or prior recap unreleased) render
  `—` across the ±Diff cells (one-sided) — free from the existing null handling.

**Direction/colours unchanged.** `diff = scored − comparand`; positive = green
(`--diff-positive`) = "scored higher than last time." The Total band + 8
subcaptions recompute against the selected basis.

**Sorting / grouping / class filters are basis-agnostic** — they key off the
computed `DiffRow`, so switching basis just recomputes rows and re-applies the
active sort. No codec change for sorts.

**Availability logic:**

- Diff tab shows when `hasScores && (hasPrediction || hasPrevious)` (today:
  `hasScores && hasPrediction`).
- Toggle offers `vs Prediction` iff `hasPrediction`; `vs Previous` iff
  `hasPrevious` (≥1 corps has a prior recap).
- If the URL selects an unavailable basis, fall back to the available one and
  re-sync the URL.

---

## 2. Data model & requirements

Left operand stays the event's actual scored recap (`ctx.scoredRecap`). The
toggle swaps the **right** operand:

- `prediction` → `ctx.baseRecap` (existing predicted rows).
- `previous` → new `ctx.previousRecap: RecapRow[] | null` — one row per
  participating corps carrying that corps's **prior show** subcaption scores
  (GE1…MP), keyed by `corps_key`, plus a `sources` map for tooltips.

`computeDiff` (`app/lib/diff.ts`) needs **no change** — it's a pure outer join on
`corps_key`, already yields the Total aggregate + one-sided nulls. We just feed it
a different right operand.

---

## 3. Read-model section (all seasons)

Prod serves from the read-model (no relational DB on the request path), so
previous-show data must be an emitted section.

**New builder** `sdk/src/readModel/builders/previousRecap.ts`:

- `buildEventPreviousRecap(db, slug) → { rows: RecapRowOut[]; sources:
  Record<corpsKey, { slug; name; date }> }`.
- Single-pass query: resolve this event's `(season, start_date)`; for each corps
  in this event, pick their max `start_date` event `< this.start_date` in the same
  season via `ROW_NUMBER() OVER (PARTITION BY corps_key ORDER BY start_date
  DESC)`; bulk-fetch `corps_scores` / `caption_scores` / `category_scores` for
  those `(competition_slug, corps_key)` pairs; fold with the **existing
  `foldRecapRows`** (`builders/recap.ts`) so it's byte-parity with the recap
  builder. Reuse `event_to_competition` resolution + `RELATED_CORPS_CTES` (alias
  handling) like `buildCorpsSeasonScores`.

**Emit + parity:**

- New `rm_event_previous_recap` table, written per-event by `emitReadModel.ts`
  (support `--only previous-recap`).
- **Bump `SCHEMA_VERSION`.**
- Add a `verifyReadModel.ts` assertion (builder vs emitted parity) per the parity
  invariant.
- Reader `readEventPreviousRecap(slug)` in `readers.ts`; the app service reads
  read-model in prod and the builder as the dev/live fallback — mirroring
  `getEventRecap`.

**2026 live path:** the current-season prediction page reads live; the same
builder backs the live fallback, so 2026 works whether or not the shard is fresh.

---

## 4. Server-fn (decoupled)

`app/lib/server-fns/hybrid.ts`: `getHybridEventPreviousRecap` — thin
`createServerFn` → `Effect.runPromise` of a service method → `{ rows, sources }`.
**Separate** from `getHybridEventPredictionPageData`, so the default page load
never pays for it.

---

## 5. State machine + query-param sync

`app/machines/prediction-machine.ts`:

- Context: `diffBase: 'prediction' | 'previous'` (default `'prediction'`),
  `previousRecap: RecapRow[] | null`, `previousSources: Record<...>`,
  `previousStatus: 'idle' | 'loading' | 'ready' | 'error'`.
- Events: `SET_DIFF_BASE`, plus actor lifecycle.
- `diffRows` selector: `computeDiff(scoredRecap ?? [], diffBase === 'previous' ?
  (previousRecap ?? []) : baseRecap)`.

**Codec** (`predictionSearchCodec`): add `diffbase` ↔ `?diffbase`, **omitting the
default** `'prediction'` (keep encode/decode symmetric — the footgun flagged in
AGENTS: a `decode` comparing the wrong type silently never matches, and a
non-omitted default churns the URL). Add `diffbase` to the route `validateSearch`
(coerce to the `'previous'` literal; anything else → undefined). Codec and
`validateSearch` must agree on type.

---

## 6. SSR + prefetch-after-load

**Prefetch (no `useEffect`).** The prefetch is an invoked `fromPromise` actor, not
a mount effect. Model it as a child state `previous: idle → (guard) loading →
ready | error`; the guard is `previousRecap == null && hasPrevious`. `invoke`
fires only client-side after hydration — which _is_ "prefetch after page load" —
so the first toggle is instant. Seeded/skipped when the loader already supplied
the data.

**SSR / deep links.** Add `diffbase` to `loaderDeps`. In the loader, when
`search.diffbase === 'previous'`, `await getHybridEventPreviousRecap` and include
it in loader data → SSR renders the previous-diff table with no spinner.
Otherwise return `previousRecap: null` and let the actor prefetch it. Seed the
machine from loader data when present (the existing `useSearchSync` `ready` gate
already waits for `baseRecap`).

**Spinner.** If the user flips to `previous` before the prefetch resolves, show a
delayed spinner via `useDelayedFlag(status === 'loading', 250)`; keep the prior
table on screen if one was shown.

---

## 7. Edge cases

- Season opener / no prior recap for a corps → one-sided `—` row (free via
  `computeDiff`).
- Event not yet scored → Diff tab hidden (both bases need the actual scored left
  operand); unchanged.
- `hasPrediction` false but `hasPrevious` true → Diff tab shows with only `vs
  Previous`.
- Multi-night / sibling-event slug pitfalls → rely on `event_to_competition` +
  the `DATA_QUALITY_NOTES` matcher, not raw slugs.
- Decimals / tint / rank recompute per basis (already keyed on the rows).

---

## 8. Files touched

- **SDK:** `builders/previousRecap.ts` (new), `emitReadModel.ts`,
  `verifyReadModel.ts`, `readers.ts`, read-model schema + `SCHEMA_VERSION`.
- **App:** `lib/event-recap.ts` (or a small `previous-recap` service),
  `lib/server-fns/hybrid.ts`, `machines/prediction-machine.ts` (+ codec),
  `routes/events/$yearSlug/$slug/prediction.tsx` (loaderDeps, loader branch,
  toggle UI, availability), `components/prediction/diff-recap-table.tsx`
  (basis-aware tooltip/label + `sources` prop).
- **Tests:** `prediction-machine.test.ts` (diffBase transition + codec
  round-trip), a builder unit test.

---

## 9. Rollout

Emit + verify locally → publish read-model to R2 → deploy. The
`computeDiff` / table changes are pure and SSR-safe.

---

## 10. Defaults (change if desired)

- Second option labelled **"vs Previous show"**.
- Tab-availability widened: show Diff when scores + _either_ basis exists.

---

## 10b. As-built status (all phases implemented)

- **Phase 1–2 shipped as designed.** Builder + service + server-fn; machine
  `diffBase` + `previous` load region + codec; toggle UI + basis-aware table;
  emitted `rm_event_previous_recap` section (`SCHEMA_VERSION` 17) + reader +
  `verifyReadModel` parity. Builder and emit→reader round-trips smoke-tested
  against in-memory fixtures.
- **Phase 3 deviation — prefetch/deep-link is machine-native, not loader-based.**
  The loader is NOT coupled to `?diffbase` (that would re-run the expensive
  prediction/recap loader on every basis toggle and double-fetch). Instead: the
  machine prefetches the moment the Diff tab opens (`SET_VIEW→loading`), and an
  `always`-guard auto-loads when `diffBase` is codec-seeded to `'previous'` from
  a deep link. Trade-off: a deep-linked `?diffbase=previous` shows a brief
  loading card during SSR/first paint instead of SSR-rendered rows — acceptable
  for a rare shared-link case, and the prefetch makes the card rare in normal use.
- **Availability:** the Diff tab gate is unchanged (`hasScores && hasPrediction`);
  the basis toggle always offers both options, and "vs Previous" degrades to a
  loading / empty / error card when there's no prior-show data.

## 11. Suggested build order

1. **App-side slice against the live builder** — server-fn + builder (live/dev
   path only), machine `diffBase` + codec + `validateSearch`, toggle UI,
   basis-aware `computeDiff` feed, tooltip/`sources`. Verifiable on `vite dev`
   (2026) immediately.
2. **Read-model section** — `rm_event_previous_recap` emit + reader + parity +
   `SCHEMA_VERSION` bump + `verifyReadModel`, so past-season/prod pages serve it.
3. **Prefetch actor + deep-link loader branch** — wire the `fromPromise` prefetch
   and the `?diffbase=previous` SSR loader branch last.
