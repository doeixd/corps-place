# Prediction Ballot — palette v2 plan

*Status: planned · Author: session 2026-07-02 · The existing `/predict/palette` stays untouched.*

## 1. Concept

A second, more social prediction surface. Where the palette is a **score editor**
(type caption numbers, watch totals recompute), the Ballot is a **rank picker**:
drag corps into the order you think they'll finish, per caption, lock it in, and
share it. The number being predicted is the corps' **finals placement** — or,
for corps that won't make finals, their season-high standing — i.e. exactly the
quantity `/rankings` already displays, so the Ballot reads as "arrange the
rankings page yourself."

**Route:** `/predict/ballot` (new file route). Old palette untouched; the
`/predict` hub (if/when one exists) links both. A locked, shared ballot lives at
`/predict/ballot/$id` (public, read-only).

## 2. Presets & the corps set

A preset picks WHICH corps you're ranking. Chips across the top (reuse
`FilterChips`, same as /rankings season/metric rows):

| Preset        | Corps set                                                     | Default size |
| ------------- | ------------------------------------------------------------- | ------------ |
| **Finalists** | top 12 World Class by current rank                            | 12           |
| Semifinalists | top 25 World Class                                            | 25           |
| World Class   | all World Class corps                                         | ~22          |
| Open Class    | all Open Class corps                                          | ~12          |
| All corps     | World + Open (the /rankings default view)                     | ~34          |

- Source of truth for "current rank" + the corps set: **`getRankings`** (the
  /rankings server-fn) — season `2026`, metric per card (see §4), divisions per
  preset. No new data plumbing; the rows already carry name/slug/logo fields.
- **Add/remove:** below the list, a collapsed "+ Add corps" row opens a picker of
  the corps excluded by the preset (searchable, reuse the corps rows visual);
  each row has a remove affordance (swipe-away on touch, an × on hover). Edits
  mark the preset chip as "Custom" (chip shows `Finalists*`).
- Preset + season are URL state (`?preset=finals`), same validateSearch/codec
  discipline as /rankings (plain-string params — see the codec lesson: single
  values as strings so canonical URLs don't 307).

## 3. The list — reorderable rankings rows

Reuse the **`/rankings` row visual** (rank number · `CorpsLogo` · name · subtle
zebra striping via `bg-muted/40`, corps palette accent on drag) but as a new
`BallotList` component — do NOT complicate `RankingsList` itself; extract the
row markup into a shared `RankingRowShell` if it stays 1:1.

- **Drag:** `@dnd-kit/sortable` (already a dependency, already used by
  `reui/data-grid` — same `DndContext` + `verticalListSortingStrategy` recipe).
  dnd-kit gives keyboard reordering (space to lift, arrows to move) and touch
  support out of the box — motion's `Reorder` does not do a11y, so dnd-kit wins.
- Rank numbers renumber live while dragging (`transition` via dnd-kit's
  transform; the row you're holding gets the corps-accent border like the
  rankings hover state).
- Rows show a small drag-handle icon on desktop hover / always on touch
  (`MenuTwoLineIcon` at `text-muted-foreground`).
- Default order = current rank for the card's caption (from `getRankings`
  metric). A "Reset to current ranks" ghost button sits under the list.

## 4. Caption cards — horizontal snap carousel

One card per ranked dimension, swiped horizontally:

```
[ Overall ] [ GE1 ] [ GE2 ] [ VP ] [ VA ] [ CG ] [ MB ] [ MA ] [ MP ]
```

- Mechanics: the site already has two horizontal-snap patterns — the weekend
  shows carousel and the as-of scrubber (`snap-x`, `carousel-scrollbar`,
  edge-fade arrows via the ShopSection edges/scrollByPage/ResizeObserver
  recipe). Reuse that: each card is a `snap-center` full-width (mobile) /
  `max-w-md` (desktop) `Card`.
- A dot/pill indicator row above (the caption keys as chips; tapping a chip
  scrolls to that card — reuse `FilterChips` in single-select mode).
- Per-card state: each caption holds its own order. "Overall" starts from
  `metric=total` ranks; captions from their caption metric ranks. Reordering
  Overall does NOT cascade into captions (independent opinions), but a "copy
  Overall to all captions" affordance is offered once (dismissable hint).
- **Scope control:** ranking 9 dimensions × 25 corps is a chore. The Overall
  card is required; caption cards are optional — an unedited caption card is
  simply omitted from the saved ballot (shown with a "using current ranks"
  watermark until touched).
- Drag-vs-swipe conflict: vertical drag (dnd-kit) must not fight horizontal
  swipe. dnd-kit's pointer sensor with a small activation distance +
  `touch-action: pan-x` on the scroll container and `touch-action: none` on the
  drag handle resolves it (the handle is the only drag-start surface on touch).

## 5. Lock-in (sign in → persist)

- Anonymous users can arrange freely (state in memory + `sessionStorage`
  autosave so a sign-in round-trip doesn't lose work — same
  `post-auth-redirect` pattern the SignInButton already uses).
- **Lock it in** button (primary, bottom of the carousel): if signed out, render
  `SignInButton` with `callbackURL` back to the ballot (the sessionStorage
  draft restores). If signed in, POST `saveBallot`.
- Semantics: one **active** ballot per (user, season, preset-set-hash). Locking
  freezes it: `locked_at` stamped, list becomes read-only with a "Locked
  <date>" badge. Re-locking later creates a new **version** (keep history —
  cheap, and lets us grade "how early were you right").
- Server: new server-fns in `app/lib/server-fns/ballot.ts` (`saveBallot`,
  `getBallot`, `myBallots`) using `requireActor` + valibot validation, writing
  `contributions.db`. Table (added via `scripts/contributions-migrations.mjs`,
  the boot-time migration list):

```sql
CREATE TABLE IF NOT EXISTS prediction_ballots (
  ballot_id   TEXT PRIMARY KEY,          -- nanoid, used in share URLs
  user_id     TEXT NOT NULL,             -- better-auth user
  season      TEXT NOT NULL,
  preset      TEXT NOT NULL,             -- 'finals' | 'semis' | 'world' | 'open' | 'all' | 'custom'
  orders_json TEXT NOT NULL,             -- { overall: [corpsKey…], GE1?: […], … } (untouched captions omitted)
  locked_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  superseded_by TEXT                      -- newer version's ballot_id (null = active)
);
CREATE INDEX IF NOT EXISTS idx_ballots_user_season ON prediction_ballots(user_id, season);
```

- Validation: corps keys must be a subset of the season's ranked corps
  (server-side re-check against `getRankings` data — never trust the list),
  each order a permutation without dupes, ≤ 40 entries.

## 6. Sharing

- **Share URL:** `/predict/ballot/$id` — SSR'd read-only view of the locked
  ballot (owner name optional/anonymizable — display name from the user row,
  with a "share anonymously" toggle at lock time). `seoHead` canonical, and
  `og:image` pointing at the OG route below.
- **Share buttons:** generalize `app/components/jobs/share-button.tsx` into
  `app/components/share-button.tsx` (it's platform links + copy-link — nothing
  jobs-specific; the jobs one becomes a re-export so nothing breaks). Add the
  native `navigator.share` path first on mobile.
- **OG image:** `app/routes/api/og/ballot/$id.ts` using the existing
  `renderOgPng` + a new `BallotCard` template in `app/lib/og/templates.tsx`:
  top ~10 rows of the Overall order (rank · corps name), the lock date, the
  preset label, and the site mark (`faviconPngDataUri` — the pattern HomeCard
  already uses). Cache headers: same `OG_HEADERS`, keyed by immutable ballot id
  → safe to cache long (a superseded ballot keeps its image).
- **Save as image:** a "Download image" button on the ballot view simply fetches
  the OG PNG endpoint and triggers a download (same blob-anchor recipe as the
  calendar .ics download) — one rendering path, zero canvas/client-render code.

## 7. Grading (phase 2, cheap but high-retention)

After finals (or continuously vs current ranks): score a locked ballot with
Spearman correlation + exact-hits against the actual /rankings order, shown as
a badge on the shared page ("87% — locked July 3"). The backtest work gives us
the vocabulary; `getRankings(asof)` gives us "what the ranks were when you
locked" for a fair baseline. Not in v1 — but the schema above (immutable locked
versions with dates) is designed so this needs zero migration.

## 8. Analytics

Direct events via the new `track()`: `ballot_reorder` (throttled, per card),
`ballot_preset` covered centrally by the `filter` param watcher (add `preset`
to `TRACKED_PARAMS`), `ballot_lock`, `ballot_share`, `ballot_image_download`.

## 9. Build order

1. **M1 — static list:** route + presets + `getRankings` wiring + BallotList
   with dnd-kit reorder, Overall card only, sessionStorage autosave. *(the fun
   is usable immediately, unshared)*
2. **M2 — caption carousel:** snap cards, caption chips indicator, per-card
   orders, "copy overall" hint.
3. **M3 — lock-in:** migration + server-fns + SignInButton flow + locked view.
4. **M4 — share:** `$id` route, OG template + route, generalized ShareButton,
   download-image.
5. **M5 (later) — grading + a "community consensus" aggregate view.**

Each milestone ships behind nothing (route is additive), verified per house
process: tsc → local prod build → hydration check with a real-UA browser →
deploy → live check.

## 10. Open questions (answer before M3)

- Display name on shared ballots: default anonymous or default named?
- One ballot per preset or one per user per season (presets as tabs of one
  ballot)? Plan assumes per-preset.
- Should locking cost anything (fantasy tie-in?) or stay free? Plan assumes free.
- All-Age preset? Excluded from v1 (curve/rank data thinner); trivial to add.
