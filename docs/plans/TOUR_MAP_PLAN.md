# Corps Tour Map — implementation plan

Status: planned (2026-06-22). Not started. Research verified against codebase + DB.
2026-07-12: §Corps-site enrichment added — 15 corps websites surveyed live (3
agents); source matrix, ingestion tiers, and map integration below.

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

## Feature inventory (v1 ships ★; rest are fast-follows)

- ★ All-corps season map (default), division filter chips, corps focus mode
- ★ Date scrubber + Today marker shared across every drawn route; scrubbing
  in all-corps mode animates the whole activity moving week by week
- ★ Hover/tap stop card: event name/date/city + which corps were there
  (shared-venue dots make multi-corps shows first-class), linking to the
  event page
- ★ Legend chips (color swatch, logo, ×) for focused corps; "Clear" returns
  to all-corps
- ★ Season stats strip under the map: shows on the map, corps touring,
  miles traveled (haversine along each route — `app/lib/geo.ts`) for the
  focused corps or the season total
- Fast-follows: shareable focused-view URLs surfaced via a Share button
  (`?c=` already encodes them); auto-play the season; "shows near me"
  (geolocation hook exists in weekend-shows); housing/rehearsal layer
  (M6-M9) as a stop-kind toggle

## Components (new / touched)

- `app/routes/tour/{-$year}.tsx` — route: loader (seasons, season dataset,
  codec-parsed c/div/asof), head(), page shell
- `app/lib/tour/codec.ts` — parseCorpsList (dedupe/cap), parseDivs reuse,
  parseAsof, `tourCanonicalPath` (+ unit tests, rankings-codec style)
- `app/lib/server-fns/hybrid.ts` → `getSeasonTour(season)` — the join,
  grouped `{ corps: [{slug,name,colors,division,stops:[[eventId,date,lat,
  lng]]}], events: {eventId: {name,slug,city,state}} }`
- `app/components/tour/tour-map-body.tsx` — REFACTOR to `series[]` + modes
  (all vs focused), shared-venue dot aggregation, hover-lift; corps pages
  pass one series (zero visual change — verify screenshots)
- `app/components/tour/tour-legend.tsx` — chips w/ logo+swatch+remove
- `app/components/tour/corps-picker.tsx` — division chips + search + logo
  rows (light; NOT AddCompareSection)
- `app/components/tour/tour-stats.tsx` — the stats strip
- `app/routes/api/og/tour.ts` (see OG below)
- `sitemap-core[.]xml.ts` + corps-page tour section + /events header: links

## SEO & OG (deepened per product ask)

- Titles: bare `/tour` → "DCI Tour Map {year} — Every Drum Corps' Summer
  Tour Route"; `/tour/2023` → "2023 DCI Tour Map — …". Description names
  the corps count + show count + date span ("97 corps, 81 shows,
  June 26 – August 8"). H1 mirrors the title (results-style intent match:
  people search "dci tour map", "drum corps tour 2026" — currently unserved
  queries with zero good answers on the web).
- `tourCanonicalPath`: `?c`/`?div`/`?asof` all collapse to the season page;
  newest season = bare `/tour`. Sitemap entries per season with ≥10
  geocoded events (never-future lastmod = latest stop date ≤ today).
- JSON-LD: `Dataset` (like rankings) + per-event `Event` refs are overkill —
  Dataset only, `dateModified` = latest scored stop.
- **OG image = an actual map render.** `/api/og/tour/$year` builds the map
  SVG server-side (d3-geo geoPath over the public/geo topology + the
  season's route polylines in brand colors — pure string templating, no
  satori limitations), rasterizes via sharp, and inlines it as a data-URI
  background layer in the standard satori card frame (same inline-PNG
  trick as logoDataUri) with title + stats overlay. Distinctive at a
  glance in feeds — nothing else in the niche has this. Focused shares
  (`?c=`) can fast-follow with per-corps OG (corps color + single route).
  Cache: `public, max-age=86400` + the og no-store error guard.

## Corps integration

- Corps page tour section header gains "Explore all tours →" linking
  `/tour/$season?c=<slug>` (focused on that corps, season preserved).
- Focused mode with one corps = superset of the corps-page map — the
  corps-page section stays (it's contextual + zero-nav), the explorer link
  is the upsell.
- /events index header action links `/tour` ("Tour map").
- Corps directory cards could later deep-link (`?c=` per card) — not v1.

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

---

# Corps-site enrichment (v2) — housing, rehearsal & free-day stops

Surveyed 2026-07-12: 15 World Class corps websites explored live. The DCI feed
only gives SHOW stops; corps sites fill the gaps between them — rehearsal days,
housing sites, free days, parades — which is what makes a tour map read as a
*tour* instead of a scatter of shows.

## Source matrix (verified live, July 2026)

| Corps | 2026 schedule | Housing/rehearsal data | Format | Feed |
|---|---|---|---|---|
| Boston Crusaders | bostoncrusaders.org/schedule/ | ✅ **Rehearsal Location column in the table** (William Allen HS, Muskogee HS, …) + free days | HTML table (easiest of all) | — |
| Carolina Crown | carolinacrown.org/calendar-list | ✅ Rehearsal sites as calendar items, "HOUSING: …" lines, "Free Day: San Antonio River Walk" | HTML cards (list view; grid is JS) | per-event .ics + Google Cal links |
| Blue Devils | bluedevils.org …&module=tour | ✅ Housing w/ full street address + full day schedule on `events/details.php?eventID=N` | server-rendered PHP; N+1 detail fetches | — |
| Blue Stars | bluestars.org/2026-season | ✅ Housing/rehearsal **Google Sheet** + "Rehearsals are free and open to the public unless otherwise communicated" | HTML + assets | ✅ **public ICS, verified 200, 604 VEVENTs**: calendar.google.com/calendar/ical/schedule%40bluestars.org/public/basic.ics (filter: includes 2017+ history, Zoom links) |
| Troopers | troopersdrumcorps.org/see-the-corps | ✅ **Dedicated housing-locations page** (with "check in first" + "do not ship" disclaimers) | Wix, JS-rendered — needs browser | — |
| Colts | colts.org/schedule-colts | ◐ Move-in, rehearsal *cities*, explicit FREE DAY rows; no site names. Volunteer Google Sheet may name sites | HTML month tables | volunteer Google Sheet |
| Cavaliers | cavaliers.org/tickets (schedule JS-rendered) | ◐ housing-info PDF: cavaliers.org/s/cavaliers_housing_information.pdf | Squarespace, needs browser for schedule | — |
| SCV | scvanguard.org/events-calendar/ | ❌ shows only | Tribe Events | ✅ ICS: `?post_type=tribe_events&ical=1` |
| Phantom Regiment | regiment.org/events/list/ | ❌ shows only (street addresses incl.) | Tribe Events | ✅ ICS: `?post_type=tribe_events&ical=1` |
| Bluecoats | bluecoats.com/events | ❌ explicit; daytime venue-addressed entries are implicit rehearsal days | Squarespace cards (static) | probe `?format=ical`/`?format=json` |
| Madison Scouts | forwardperformingarts.org/madison-scouts/events | ❌ housing; ✅ **parades/non-DCI local events** DCI doesn't list | plain HTML list | — |
| Crossmen | tour page = JS shell → redirects to dci.org/events/?corp=66888 | ❌ | delegates to DCI SPA | — |
| Blue Knights | ascendperformingarts.org | ❌ (calendar JS-rendered, hosted events only) | needs browser | — |
| Mandarins | hiatus 2026 (returning 2027; 2025 page named rehearsal schools) | n/a | — | — |
| The Cadets | **defunct** (Ch. 7, Apr 2024) — domain parked | n/a | — | — |

Cross-cutting: `dci.org/events/?corp=<id>` is the shared canonical backend
(Crossmen 66888, Blue Stars 66874, …) — reverse-engineering that once covers
every corps' SHOW list, but never housing.

## Data model

New relational table `corps_tour_stops`:
`(corps_key, season, date, kind, name, venue_name, address, city, state,
lat, lng, start_time, end_time, open_to_public, source_url, source_kind,
raw_json, scraped_at)` with `kind ∈ show | rehearsal | housing | free_day |
parade | move_in`. Read-model: `rm_corps_tour` detail shard per corps+season
(joins DCI show stops with enrichment stops, deduped — see below). The v1
`TourStop` type gains `kind` + `openToPublic`.

Dedupe rule: enrichment SHOW entries that match a DCI event (same date +
fuzzy city/venue) are dropped in favor of the DCI row (which has results,
slugs, links); everything else (rehearsal/housing/free-day/parade) is additive.
Housing lines attached to a show entry (Crown's "HOUSING: X") become a
separate `housing` stop on the same date.

## Ingestion tiers (per-corps adapters, one nightly/weekly cron in-season)

- **T1 — feeds (cheapest, do first):** Blue Stars ICS (filter by season window
  + event type), SCV + Phantom Tribe ICS, Crown per-event ICS, Bluecoats
  Squarespace `?format=json` probe. Standard node-ical parse; LOCATION carries
  addresses.
- **T2 — static HTML scrape:** Boston (the Rehearsal Location table — highest
  housing value per line of code), Crown calendar-list cards, Madison list
  (parades!), Colts month tables (free days/move-in), Blue Devils list +
  bounded N+1 `details.php` fetches (housing addresses + day schedules).
- **T3 — browser-rendered (reuse BrowserbaseService):** Troopers see-the-corps
  + housing-locations, Cavaliers tickets schedule, Blue Knights calendar.
- **T4 — one-off assets, manual-ish cadence:** Cavaliers housing PDF, Blue
  Stars + Colts Google Sheets (public CSV export URLs).
- Geocode via the existing `geocodeVenues.ts` pipeline (cache by address);
  stops that fail geocoding keep city-level coordinates (geocode the city).

## Map integration

- Pin taxonomy: show = solid corps-color pin (v1); rehearsal/housing = smaller
  hollow pin; free day = star; parade = flag. Route legs to non-show stops
  drawn dashed. Timeline scrubber includes all stop kinds.
- "Rehearsal & housing stops" is a per-corps TOGGLE, shown only when
  enrichment exists for that corps+season (coverage varies wildly — matrix
  above). Tooltip shows source + scraped_at ("via bostoncrusaders.org,
  checked Jul 12").
- Open-rehearsal stops (Blue Stars policy, BD published day schedules) get an
  "open to the public" badge — that's the fan-facing payoff.

## Editorial/safety policy (decide before shipping)

Housing sites are schools where minors sleep. The corps publish them for fans
and volunteers, but aggregating them deserves care:
- Default: show `housing` stops at **city level** (no street address) with a
  link to the corps' own page for details; show full venue only for stops the
  corps explicitly opens to the public (open rehearsals, Blue Stars policy).
- Honor the source disclaimers (Troopers: "check that this information is
  current") — always render the source link + last-checked date.
- Never surface housing in search/SEO surfaces; the map section is enough.

## Milestones (v2, after v1 M1–M5)

- **M6** — `corps_tour_stops` table + T1 feed adapters (Blue Stars/SCV/
  Phantom/Crown) + `rm_corps_tour` emit section + dedupe-vs-DCI tests.
- **M7** — T2 HTML adapters (Boston, Crown cards, Madison, Colts, Blue Devils
  incl. details) + geocoding + refresh cron (`refresh-tour-stops.sh`, weekly
  in-season) with per-corps failure isolation + ingest_runs recording.
- **M8** — map layer: kind-styled pins, dashed legs, toggle, source
  attribution, open-to-public badge; city-level housing policy.
- **M9** — T3 browser adapters (Troopers, Cavaliers, Blue Knights) + T4
  assets; per-corps coverage table on the admin jobs page.

---

# /tour/$year — season tour explorer (planned 2026-07-13)

A standalone marquee page: the whole season's tours on one US map — multiple
corps' routes in brand colors, corps picker, date scrub. v1 corps-page map
(shipped) is single-corps; this composes the same pieces season-wide.

## Verified data reality

One join over EXISTING read-model tables — no schema work:
`rm_corps_appearances × rm_events (venue_latitude/longitude, M1) × rm_corps
(colors/logos/division)`. 2026: 97 corps, 683 geocoded corps-stops; division
split World 19 / Open 18 / All-Age 15 / SoundSport 34. Historical seasons work
wherever M1 geocoding reached (2019/2022-24 strong; 2025 partial).

## Design decisions (each follows a surveyed in-app convention)

- **Route: `/tour/{-$year}`** (optional path param, corps-page style): newest
  season lives at bare `/tour` (canonical), others at `/tour/2023`. Year is
  the page's identity → path, not search (shows/corps precedent). Loader
  validates the year against available seasons, redirects unknown → bare.
- **DEFAULT = ALL CORPS** (product decision 2026-07-13): the bare page draws
  every corps' tour for the season — the "whole activity criss-crossing the
  country" wow-shot IS the page. Legibility strategy for ~97 routes/683
  stops (fine for SVG, <1k nodes):
  - all-corps mode: thin low-opacity brand-colored routes (strokeOpacity
    ~0.35, width 1.25), small pins only at shared venues (venue dots sized
    by how many corps hit them), no per-corps pins;
  - hover/tap a route or a corps chip → that corps lifts to full opacity +
    full pins; others dim (rankings hover-highlight precedent);
  - selecting corps (picker/legend) switches to focused mode: only the
    selected routes, full pins, exactly the shipped corps-page look.
- **Corps selection: `?c=slug,slug,…`** — compact param (vs `?s=`
  precedent), canonicalized on every push, `replace: true, resetScroll:
  false`. Param-free default = all-corps mode; `?c=` values switch to
  focused mode. Soft cap 12 for FOCUSED selections (VS_SERIES_CAP) — the
  all-mode has no cap since it fetches nothing extra. `?div=` filters the
  all-corps mode to divisions (world/open/all-age/soundsport, rankings
  parseDivs precedent).
- **Date scrub: `?asof=YYYY-MM-DD`** (rankings precedent) + the existing
  tour scrubber/Today-marker UX; axis = full season span (min..max stop
  date across ALL selected corps). Param-free default = today (in-season) /
  full reveal (historical) — matching the corps-page map behavior.
- **URL codec module** `app/lib/tour/codec.ts` (plain validateSearch,
  rankings-style — no state machine) with unit tests; `tourCanonicalPath()`
  shared by head() and sitemap-core (rankingsCanonicalPath pattern:
  newest → `/tour`, else `/tour/$year`; `?c`/`?asof` always collapse).
- **Colors**: brand hue per corps via `corpsPalette`; collision/brand-less
  fallback = the /vs 12-color oklch categorical ramp (`assignVsColors`
  pattern — consider extracting the ramp from app/lib/vs/colors.ts).
- **Picker**: NOT the 643-line AddCompareSection — a lighter panel:
  division FilterChips (World/Open/All-Age/SoundSport) + search input +
  logo'd corps rows with toggle checkmarks, "at cap" notice. Selected corps
  render as legend chips above the map (color swatch + name + ×-remove,
  vs chart-primitives style). Hovering a legend chip highlights that route
  and dims others (rankings hover-highlight precedent).
- **Payload — MEASURED 2026-07-13, no longer an estimate**: the full 2026
  dataset as `[eventId, date, lat(4dp), lng(4dp)]` tuples + corps headers +
  a compact event index = **69.6KB raw / 7.6KB gzip** (683 stops, 97 corps,
  80 events; event index alone ~2KB gz). Comfortably shippable in the
  loader — no split-fetch fallback needed. TSR/seroval inflates raw ~1.3×;
  still fine (compare: home's payload is 128KB). 4-decimal coords (~11m)
  exceed ZIP-centroid accuracy anyway. `getSeasonTour(season)` is a hybrid
  server-fn (edge+SW cacheable, immutable-ish between emits).
- **Map body**: generalize the shipped tour-map-body to multi-series —
  `TourMapBody({ series: { slug, name, colors, stops }[] , asof, … })`.
  Same lazy shell (aspect-ratio placeholder, d3-geo/topojson in the lazy
  chunk, module-level geometry cache — already shared with corps pages).
  Route lines per corps; pins shrink when >3 corps selected; same-venue
  same-day pins get the existing cluster offset. Single-corps page keeps
  its current look by passing one series.
- **Chrome/SEO**: PageShell + PageHeader; seoHead with per-season title
  ("2026 DCI Tour Map — every corps' route"), Dataset JSON-LD (dateModified
  = latest stop ≤ today, never future); sitemap-core adds `/tour` + a
  `/tour/$year` per season above a coverage threshold (≥10 geocoded
  events). `staleTime: 5 * 60_000`. Nav: no new item — link from /events
  header actions + corps-page tour section ("Explore all tours →").

## Milestones

- **T1 — data + codec**: `getSeasonTour` hybrid fn (join above, grouped by
  corps, season-validated), `app/lib/tour/codec.ts` (+tests: c-list parse/
  cap/dedupe, asof, canonical path).
- **T2 — multi-series map**: refactor tour-map-body to `series[]` (corps
  pages pass one series — zero visual change, verify), per-corps colors,
  legend chips with remove/hover-highlight, shared scrubber across series.
- **T3 — page**: `/tour/{-$year}` route (loader: seasons + full-season
  dataset; measure TSR payload vs the ≤15KB-gz budget), all-corps default
  + focused mode, picker panel, SeasonChips, stats strip, empty/sparse
  states (StatusCard), mobile (picker collapses into a details disclosure
  like /rankings filters).
- **T4 — SEO + OG + polish**: canonical helper + sitemap entries, the
  map-render OG card (/api/og/tour/$year), "Explore all tours" links from
  corps tour sections + /events, smoke-test entries in test-site-pages.mjs.

## Rendering performance (all-corps mode is the hot path)

- **No framer-motion on the 97 routes.** The corps-page map animates ONE
  route with a spring; 97 springs = jank. All-corps routes are plain
  `<path>` with CSS `transition: opacity/stroke-width 150ms` for hover
  lift. The drop-spring/pathLength animation stays exclusive to focused
  mode (≤12 series).
- **Scrub re-render is per-STEP, not per-frame**: the scrubber is discrete
  (~43 season days); a step change re-renders 97 paths once — fine.
  Per-corps reveal = `strokeDasharray/offset` from a cumulative-length
  table (computed once per dataset on mount, cached), so a step is a style
  write, not a path rebuild.
- **Pins**: all-corps mode renders the 72 shared-venue dots (measured:
  ZIP-centroid geocoding collapses 683 stops onto 72 distinct coords),
  never 683 pins. Focused mode renders that corps' pins only.
- **Hit areas**: each route gets an invisible 8px-wide twin path for
  hover/tap; venue dots get r≥8 transparent halos (mobile targets).
- **SVG node budget**: ~97×2 paths + 72 dots + states ≈ ~350 nodes — well
  inside comfortable SVG range; no canvas/WebGL needed.
- **SEO content is NOT the SVG**: crawlers see nothing in a client-rendered
  map. The page SSRs a real text section beneath it — "Corps touring in
  {year}" (linked corps list with show counts) and a biggest-shows list —
  also the honest content for screen readers.

## Edge cases, correctness & assumptions (decided up front)

- **SoundSport excluded by default** (34 of 97 corps; local/non-competitive
  clutter — rankings precedent). Opt-in via division chips (`?div=`).
- **22 corps have <2 geocoded stops** (measured): drawn as a single venue
  dot, no route; picker shows a "1 mappable stop" hint, not hidden.
- **ZIP-centroid truth-in-labeling**: coords are ZIP centroids (± miles) —
  distinct venues in one ZIP merge into one dot; routes are approximate.
  Stop cards group by COORDINATE and list all events there; copy says
  "approximate locations"; never imply street-level precision.
- **Dupes/order**: dedupe stops by (corps,eventId); same-day double-shows
  order by date then eventId — sub-day leg order unknowable from our data
  (documented assumption, invisible at national scale).
- **AlbersUSA insets**: null-projection legs are skipped (shipped guard);
  no AK/HI shows exist in the data (verified all coords project).
- **`?c=` hygiene**: unknown/duplicate/not-touring slugs dropped, >12
  truncated (codec unit tests); empty result falls back to all-corps mode.
- **`?asof=`**: clamp to [first,last] stop date; invalid → default (today
  mid-season / full reveal historical) — corps-page semantics.
- **Year param**: coerce to string defensively; zero-coverage year →
  redirect bare /tour; partial coverage renders with the stats strip
  saying "41 of 81 shows mappable" (2025) — honesty over hiding.
- **Freshness model**: stops appear when events GEOCODE (schedule-shaped),
  not when scores land — mid-season the whole season is already drawn and
  the scrubber conveys progress. Assumes the events table carries the full
  announced schedule (true — refresh-lineups cron maintains it).
- **Slot-flip correctness**: getSeasonTour reads one read-model slot in one
  query set per request — A/B flips can't mix seasons (same guarantee all
  hybrid fns rely on).
- **OG failure**: /api/og/tour returns no-store on error (satori/sharp can
  fail); /api/og has no CF cache rule so there's no poisoning class.

Rough effort: T1+T2 one session, T3+T4 one session. Housing/rehearsal
enrichment (M6-M9 above) composes onto this page later as an extra stop
layer — the series shape should carry `kind` from day one to leave room.
