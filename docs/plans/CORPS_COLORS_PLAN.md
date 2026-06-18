# Corps Colors Plan — per-group accent colors

Goal: give every corps a small brand palette (two base colors) used across the
site as an accent — favorites, the corps page, and chart series. Colors are
**auto-generated from the logo**, **hand-editable on an admin page**, **stored**
in the relational DB, and **emitted** into the read-model like every other corps
field.

## Design decisions (recommended)

- **Store two base colors per corps, derive the rest.** `color_primary` +
  `color_secondary` (hex). Light/dark-mode accent, accent-foreground, muted
  background, and chart color are all *derived deterministically* from those two
  via a shared pure function — not stored 6×. This mirrors how `app.css` already
  generates a full ramp from oklch hue/lightness, and keeps the editor simple
  (you tune 2 swatches, everything else follows). The derived palette is
  recomputed identically in the app and the editor preview, so they can't drift.
- **Source of truth = `corps` table** (the big `dci-relational.db`), exactly like
  `corps_logo`, `display_city`, `about`. Auto-extraction writes it; the editor
  overwrites it and marks it curated so re-ingest never clobbers a hand-picked
  color (the existing `corps_curated_fields` mechanism — `field = 'colors'`).
- **Emit into `rm_corps`** so reads stay indexed key-lookups; bump
  `SCHEMA_VERSION` 6 → 7. Flows into the JSON snapshot automatically through
  `readCorpsDirectory`.

## Color model

Store per corps:
```
color_primary   TEXT   -- '#RRGGBB'
color_secondary TEXT   -- '#RRGGBB'  (nullable; falls back to a rotation of primary)
color_source    TEXT   -- 'auto' | 'manual'  (manual == edited; also recorded in corps_curated_fields)
```

Derive at render time (pure fn `corpsPalette(primary, secondary, mode)` in a new
`sdk/src/corpsColors.ts`, shared by app + editor + a default for un-set corps):

- `accent`        – primary, lightness/chroma clamped for legible-on-surface in the active mode
- `accentFg`      – white/near-black chosen by WCAG contrast against accent
- `accentMuted`   – primary at low chroma + high lightness (light) / low lightness (dark) for tinted pills/favorite chips
- `chart`         – primary at a chroma/lightness tuned for line/area on the chart surface
- `chart2`        – secondary, same treatment (for two-tone or A/B series)
- `ring`/`border` – primary, subtle

All math in oklch (convert hex→oklch once), matching the existing token system.
Light vs dark is just different lightness targets — no second stored color set.

## Auto-generation (new sdk step)

`sdk/scripts/extractCorpsColors.ts` — mirror `flagDarkLogos.ts`:
- Reuse the logo bytes from `media-cache.db` and `sharp` (already a dep).
- New pure module `sdk/src/logoColors.ts` (sibling of `logoDarkness.ts`, unit
  tested): downscale to ~64px, ignore near-transparent + near-white/near-black
  pixels, k-means or coarse hue-histogram over opaque saturated pixels → pick the
  dominant saturated color as `primary` and the next most distinct hue as
  `secondary`. Fall back to the site `--color-primary` when a logo is
  monochrome/empty (the dark-logo corps).
- `--apply` writes `corps.color_primary/secondary/source='auto'`; default is a
  dry-run report (same ergonomics as `flagDarkLogos.ts`).
- Skip corps whose `colors` field is in `corps_curated_fields` (never overwrite a
  manual pick) — same guard `flagDarkLogos` uses for `corps_logo_dark`.
- Wire into `seasonUpdateWorkflow.ts` after the logo steps (best-effort), so new
  corps get auto colors on ingest.

## Schema / emit changes

1. `relational.ts` `ensureColumns`: add `color_primary`, `color_secondary`,
   `color_source` to `corps` (idempotent ALTERs, like `corps_logo_dark`).
2. `builders/corps.ts`: add the 3 fields to `CorpsSummary` + every SELECT
   (`buildCorpsDirectory`, `buildCorpsByKeys`, `buildCorpsBySlug`).
3. `emitReadModel.ts`:
   - `rm_corps` table: add `color_primary`, `color_secondary`, `color_source`.
   - push them in the `corpsRows` map + the `insertRows` column list.
   - `SCHEMA_VERSION = 7`; add the v7 changelog comment.
4. `readers.ts`: `readCorpsDirectory` + `readCorpsByKeys` map the new columns.
5. Re-emit (`npx tsx scripts/emitReadModel.ts`) to publish + refresh the JSON
   snapshot (`--json-snapshot ../public/read-model`).

## Editor page

Route (admin-only): `app/routes/admin/corps-colors.tsx` — a grid of corps cards,
each showing logo + current swatches + two color inputs and a live derived
preview (favorite chip, an accent button, a mini chart line) rendered with
`corpsPalette()` in both light and dark.

- Loader: `readCorpsDirectory` (already has the colors after the emit).
- Save: a server fn that writes `corps.color_primary/secondary`,
  `color_source='manual'`, and calls `markCorpsFieldsCurated(corpsKey,
  ['colors'], 'admin-editor')` against the big relational DB. (The read-model is
  derived, so editing it directly would be lost on the next emit — write the
  source, then re-emit.)
- Add a "re-emit" affordance (button or doc note) so saves go live; or have the
  save fn trigger `runEmit` for the `corps` section… note the partial-emit guard
  means `--only corps` writes a `.partial.db` and does NOT publish, so a full
  re-emit is required to publish. Simplest: save → manual full re-emit.
- Optional: a "regenerate from logo" button per corps that runs the extractor for
  one corps and shows the suggestion before saving.

Dev-only for now — there is no admin/auth mechanism yet, so the route and its
save server fn are gated on `import.meta.env.DEV` (404 / throw in production)
rather than shipped unauthed. Revisit + add real auth when it lands.

## Consumption across the UI

- **Favorites:** OUT OF SCOPE — favorites aren't implemented yet. This plan only
  supplies the color tokens; when favorites land they'll tint the chip/badge with
  `accentMuted` + `accent` border. No favorites work happens here.
- **Corps page:** set CSS vars (`--corps-accent`, `--corps-accent-muted`, …) on
  the page root from `corpsPalette()` so existing components pick them up.
- **Charts:** the season-scores chart and recap charts take the corps `chart`
  color per series instead of the generic `--chart-*` ramp; two-corps compares
  use `chart` vs `chart2`.

## Sequencing / status

1. ✅ `sdk/src/corpsColors.ts` (derivation) + `sdk/src/logoColors.ts` (extraction) + unit tests (30 assertions, green).
2. ✅ Relational columns (`relational.ts`) + `extractCorpsColors.ts`; ran `--apply` (135/136 corps have colors).
3. ✅ Builders + emit (`rm_corps` cols) + readers; SCHEMA_VERSION → 7; full re-emit published + JSON snapshot. Verified.
4. ✅ Dev-only editor (`app/routes/admin/corps-colors.tsx`) + save fn (`app/lib/server-fns/corps-colors.ts`), curated guard + live slot patch.
5. ⬜ Wire colors into corps page / charts / (future) favorites.
6. ⬜ Add `extractCorpsColors` to `seasonUpdateWorkflow`.

(Also fixed while validating this branch: `app/db/collections.ts` now falls back to
`event.slug` when `event_id` is absent, so `vp check` has no blocking errors.)

## Out of scope / deferred

- **Admin auth** — none exists yet; the editor is dev-only (`import.meta.env.DEV`-gated). Add real auth later.
- **Favorites** — not implemented yet; colors are supplied for it, but the
  favorites feature itself is separate, later work.

## Open question

- One color or two as the *primary* chart series default? (plan assumes primary,
  secondary only for compares / two-tone — fine to defer to implementation).
</content>
</invoke>
