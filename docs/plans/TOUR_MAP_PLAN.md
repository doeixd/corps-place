# Corps Tour Map — implementation plan

Status: planned (2026-06-22). Not started. Research verified against codebase + DB.

## Goal

A minimalistic, beautiful, fully-featured `<TourMap>` component that shows a corps's
season tour as a route across a US map: dropped pins per appearance (corps colors,
clickable → event page), a connecting route line, and a **scrubbable date timeline**
that **progressively reveals** the tour. Embeds as a section on `/corps/[slug]` for
the active season. SSR-safe, mobile-first, performance-conscious.

## Key design decisions (confirmed with product)

1. **Render = inline `<svg>` + d3-geo / topojson-client.** No map lib exists; we add
   the *small* `d3-geo` + `topojson-client` (~30kb) and a US-states TopoJSON asset in
   `public/`, projected with **`geoAlbersUsa`** (USA-only, handles AK/HI insets — but
   the tour is CONUS so this is just a safe default). **No mapbox/maplibre/leaflet.**
   The projection lib + topojson asset are **lazy-loaded** (`await import(...)`) behind
   the SSR `mounted` gate so they never land in the initial/SSR bundle.
2. **Scrub = progressive route reveal.** A date timeline scrubber draws the route line
   and drops pins up to the scrubbed date; earlier stops stay visible but dimmed,
   future stops hidden. "Watch the tour unfold." Auto-play optional (follow-up).
3. **Corps page embed first; ephemeral local state (NOT in URL).** Season comes from
   the page's existing URL (`/corps/$slug/{-$season}`). The scrubbed date / selected
   stop are local component state. (URL-state + a standalone `/tour` explorer are
   noted as follow-ups.)
4. **Corps colors** for route line + pins (`corpsPalette`), dark-mode aware. Pins
   **drop** with a spring and are **clickable**, linking to the event page.
5. **USA-only** — `geoAlbersUsa` returns `null` for out-of-bounds points; we already
   only have US tour data, but guard for `null` projections defensively.

## Data realities (VERIFIED against codebase + sdk/dci-relational.db)

- **Appearances are already fetched** on the corps page via `getCorpsAppearances`
  (`$slug.{-$season}.tsx:56`, read-model shard `corps-appearances/<slug>.json` →
  fallback server fn). Returns `EventDirectoryRow[]` (`events.ts:10-41`) +
  `appearanceResults` map. Each row has `start_date`, `start_time`/`web_start_time`/
  `edt_start_time`, `timezone`, `location_city`, `location_state`, `venue_name`,
  `venue_address`, `season`, `slug`, `competition_slug`.
- **Lat/lng exist but NOT in the client shape.** Coordinates live only in the
  relational `event_venues` table: `venue_latitude`, `venue_longitude`, `geocode_city`,
  `geocode_state` (populated by `geocodeVenues.ts`). **2026 coverage = 80/81 events.**
  The home page is the only current consumer (`buildHomeWeekendShows` `home.ts:347`
  joins `event_venues` and exposes `{lat,lng,city,state}` — the reference query).
- **⇒ Emitter/builder work is required** to get lat/lng into the client (this is the
  one real backend task). The corps page reads prebuilt `rm_events` shards, which have
  no coordinate columns. Path: add `venue_latitude`/`venue_longitude` (+ geocode_city/
  state) to `EventDirectoryRow` and the `buildAllEvents`/`buildEventsForSeason` joins
  (`events.ts`), to the `rm_events` CREATE TABLE + insert tuple (`emitReadModel.ts:
  203-216, 446-499`), and the `rm_events→EventDirectoryRow` mapper (`readers.ts:44`);
  then re-emit + republish. The 1 missing 2026 venue (and any historical gaps) must be
  handled gracefully (drop from map, keep in list).
- **Event page link**: `to="/events/$yearSlug/$slug/prediction"`, `params={{ yearSlug:
  event.season ?? '2026', slug: preferredEventSlug(event) }}` where
  `preferredEventSlug = competition_slug ?? slug` (`dci-links.ts:44`, `event-card.tsx:74`).
- **No map libs / geo assets installed** (verified package.json + repo). Must add
  d3-geo + topojson-client + a US-states TopoJSON in `public/`.
- **Reusable idioms:**
  - SSR-deferred render: inline `mounted` flag + fixed-height placeholder
    (`corps-score-chart.tsx:173`). No `ClientOnly` wrapper exists — use the flag.
  - Distances: `app/lib/geo.ts` (`LatLng`, `haversineMiles`, `formatDistance`).
  - Pin-drop spring: `favorite-corps-button.tsx:99` (`type:'spring', stiffness:600,
    damping:16, mass:0.5`). Sequenced reveal: `staggered-grid.tsx:74` stagger.
  - Route-line draw: animate `pathLength` 0→1 on a `motion.path` (static dash analog
    in `judge-avatar-ring.tsx:60`).
  - Scrubber: build on `ui/slider.tsx` (base-ui Slider, touch/keyboard/drag handled);
    discrete date stops can also use `FilterChips`/`ShopSection` scroll+arrows for the
    list-of-stops rail.
  - Colors: `corpsPalette(colors, theme)` JS (`corps-score-chart.tsx:151`) or
    `corpsPaletteVars` to scope `--corps-*`; theme via `useSelector(themeStore, ...)`.
  - Code-split: route-based + runtime `await import(...)` (e.g. thumbhash in
    `$slug...tsx:94`). No `React.lazy`. Mirror this for d3-geo/topojson.

## Component model

`app/components/tour/tour-map.tsx` — props:

```ts
type TourStop = {
  slug: string; competitionSlug: string | null; season: string;
  name: string; date: string; time: string | null;
  city: string | null; state: string | null; venue: string | null;
  lat: number; lng: number;            // map-eligible stops only
  place?: number; total?: number;      // from appearanceResults
};
type TourMapProps = {
  stops: TourStop[];                   // pre-sorted by date, lat/lng present
  colors: { primary: string | null; secondary: string | null };
};
```

Parent (corps page) maps `EventDirectoryRow[]` + `appearanceResults` → `TourStop[]`,
dropping rows without lat/lng (kept in the existing appearances list, just not pinned).

## Milestones (commit each)

### M1 — Expose coordinates in the read-model (backend)
- Add `venue_latitude`/`venue_longitude` (+ `geocode_city`/`geocode_state`) to
  `EventDirectoryRow` and the events builders' `event_venues` join (model on
  `buildHomeWeekendShows`).
- Thread through `emitReadModel.ts` (table + insert) and `readers.ts` mapper.
- Re-emit + republish read-model; verify shard parity. Null-coord rows tolerated.

### M2 — US map base (SSR-safe, lazy)
- Add `public/geo/us-states.topojson` (low-poly CONUS states) + deps `d3-geo`,
  `topojson-client`.
- `app/components/tour/us-map.tsx`: inline `<svg>` with `mounted` gate + fixed-aspect
  placeholder (no CLS). On mount, `await import('d3-geo')`/`topojson-client`, build a
  `geoAlbersUsa` fitted to the topojson (or to the tour bounds), render state outlines
  with theme CSS vars (`--color-border`, subtle fill). `viewBox`-based, responsive.
- Pure `project(lat,lng) → [x,y]|null` helper; guard nulls (USA-only).

### M3 — Pins + route line (corps colors, animated, clickable)
- `app/components/tour/tour-pins.tsx`: a `motion` pin per stop using `corpsPalette`
  hue; **drop** spring (favorite-button recipe), sequenced by date (stagger). Pins are
  `<Link to="/events/$yearSlug/$slug/prediction">` (preferredEventSlug). Hover/focus
  shows a small stop card (date, city, venue, result). base-ui `Tooltip` on pins.
- Route line: `motion.path` through projected points in date order, animated
  `pathLength` 0→1, corps color, thin/elegant. Optional leg-distance labels via
  `haversineMiles`.

### M4 — Scrubber + progressive reveal
- `app/components/tour/tour-scrubber.tsx` on `ui/slider.tsx`: a date timeline (min=first
  show, max=last). Scrub value → `revealDate`. Map shows route + pins with `date <=
  revealDate` (past dimmed, current emphasized, future hidden); `pathLength` tracks the
  scrub fraction so the line draws as you scrub.
- Discrete stop rail beneath (mobile horizontal-scroll + desktop prev/next arrows,
  `ShopSection` mechanics) listing stops; tapping one sets `revealDate`/selected stop.
- Reduced-motion respected (global `MotionConfig reducedMotion="user"`); `initial={false}`
  on SSR roots; instant (non-animated) state when reduced motion.

### M5 — Corps page embed + polish
- Add a `<Card>`/`<section>` "Season Tour" block on `$slug.{-$season}.tsx` when ≥2
  map-eligible stops exist; seed from the already-loaded appearances (no new fetch).
- Empty/sparse states (0–1 geocoded stops → hide map, keep list). Loading placeholder.
- Mobile: full-width map, comfortable touch targets, scrub via slider drag.
- Tests: `EventDirectoryRow→TourStop` mapping (drops null coords, sorts by date),
  pure `project()` (known lat/lng → expected quadrant; out-of-US → null),
  reveal filter (only `date<=revealDate`), link slug = preferredEventSlug.
- Verify on a corps with a full 2026 tour (pins drop, line draws, scrub reveals,
  pin → event page) + a sparse historical season.

## Edge cases
- The 1 un-geocoded 2026 venue (+ historical gaps): excluded from map, retained in the
  appearances list; if <2 geocoded stops, hide the map entirely.
- Two shows same day / same venue: stable order (date then time then name); overlapping
  pins get a slight cluster offset or a "+N" so they're individually clickable.
- `geoAlbersUsa` returns null (non-CONUS / bad coord): skip that pin, never crash the path.
- Very long tours: cap visual density (thin line, small pins); list rail carries detail.
- Off-season / no appearances: section not rendered.
- SSR: never import d3-geo/topojson on the server; placeholder reserves height to avoid CLS.

## Open questions (address later)
- Topojson source/resolution (us-atlas states-10m vs a hand-trimmed low-poly) and whether
  to pre-simplify for size.
- Auto-play "unfold" animation on first view vs scrub-only.
- Exact pin visual (teardrop vs dot+halo) and selected-stop card layout.
- Whether to show distance/total-miles summary for the tour.

## Follow-ups (not v1)
- URL state for scrubbed date / selected stop (shareable tour moments).
- Standalone `/tour` explorer (compare multiple corps' tours, multi-season).
- Animated auto-play with play/pause.
- Cluster/zoom-to-region interaction for dense northeast legs.
