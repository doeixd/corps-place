# Home "Shows near you this weekend" — implementation plan

Status: code complete; carousel live via builder fallback.

Update (2026-06-19): Step 1 geocoding is at its ceiling — 80/81 2026 venues
geocoded, 1 guarded/unparseable address (re-running won't help). Step 2 read-model
wiring verified: a full `emitReadModel.ts` publishes `rm_home_weekend_shows` (7
weekend buckets) + `rm_home_latest_results` + `rm_home_standings` and flips the
pointer (SCHEMA_VERSION 12). The local dev read-model has been re-emitted. Remaining
ops step to move production off the builder fallback onto the read-model hot path:
push the read-model to R2 (`npm run push:data read-model`) so the serving container
pulls it. Step 3 UI (carousel, geo, useGeolocation) is complete and live.

## Goal

A data-driven home module: a horizontally scroll-snapping carousel of the shows
happening **this weekend** (Fri–Sun), each card showing the **lineup** of corps
performing. If the user grants geolocation, reorder **nearest-first** and label
each card with distance ("42 mi away"). Falls back to date-order when location is
denied/unsupported. Rolls forward to the next weekend with shows when the current
weekend is empty (e.g. pre-season).

## Data realities (verified 2026-06-12)

- 2026 season runs **2026-06-26 → 2026-08-08** (so "this weekend" is pre-season now).
- All **81** 2026 events have a venue **with a full address** (100%).
- `event_venues.address` is a smushed `"<name><street><city>, ST ZIP"` string;
  the `, ST ZIP` tail matches `/,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/` on 100% of 2026 rows.
- `venue_latitude` / `venue_longitude` columns exist but are **100% empty** → must geocode.
- `zio_postcode` is empty; `venue_city`/`venue_state` on `events` are empty — address is the only location source.
- Geocoder available: **geocode.maps.co** via `GEOCODING_API_KEY` (repo-root `.env`); 25k req, 5 req/sec then 1/sec.
- No IP-geolocation service → location is browser-Geolocation-only (permission prompt), so prompt-on-tap, date-order default.

## Step 1 — Geocode venues (`sdk/scripts/geocodeVenues.ts`)

- Add provenance columns (guarded `ADD COLUMN`, never via `ensureRelationalSchema`):
  `geocode_source TEXT` ('address'|'zip'|'failed'), `geocoded_at TEXT`.
- Pure `parseVenueAddress(raw) → { state, zip }` (tail regex; 100% on 2026).
- Per venue: (1) geocode full raw address; accept if returned state matches parsed
  state. (2) fallback `"<ZIP>, USA"` centroid → source 'zip'. (3) else 'failed'.
- Cache responses in `api_responses` (cache-before-fetch); 5 req/sec ceiling w/ 429 backoff to 1/sec.
- Guardrails: reject coords outside US bbox or with mismatched reverse state.
- Flags: `--dry-run` (default-safe), `--year 2026` (default current season), `--all`, `--slug`, `--refresh`.
- Idempotent: skip rows with coords unless `--refresh`.

## Step 2 — Read-model `home` section

- `sdk/src/readModel/builders/home.ts` → `buildHomeWeekendShows(db, { now })`.
- Store **all** season weekend buckets (Fri–Sun) so the data is NOT time-sensitive;
  the reader picks the current/next-non-empty bucket at request time.
- Per show: slug, name, date, startTime, venueName, city, state, lat, lng, and the
  **lineup** (corps name + class + performance order, performance entries only) reusing
  the schedule/lineup builders. Include corpsSlug for deep links.
- Emit (`scripts/emitReadModel.ts`): `SCHEMA_VERSION 5→6`; add `'home'` to `Section`/`ALL_SECTIONS`;
  new `--only home` block → `rm_home_weekend_shows` (+ lineup table or JSON column).
- Reader `readHomeWeekendShows(db, now)` in `src/readModel/readers.ts`.
- Parity assert in `scripts/verifyReadModel.ts`.

## Step 3 — App loader + carousel

- Home `loader` reads weekend shows, **date-ordered** (SSR-safe). `staleTime` set. No client fetch.
- `<WeekendShowsCarousel>` / `<ShowCard>`: scroll-snap row; venue + city/state; lineup via `<For>` +
  `ClassBadge` linking to `/corps/$slug`; "This weekend"/"Opening weekend" chip; distance chip when located.
- `useNearbyShows` XState actor (the one legit client effect): prompt-on-tap → haversine
  (`app/lib/geo.ts`, pure) → re-sort nearest-first + scroll + distance chips. Denied → date order.
- `initial={false}` on the motion root (no SSR fade-flash). Empty/off-season state handled.

## Rollout (commit each)

1. Geocoding script + parser tests → `--dry-run` 2026 → apply.
2. `home` builder + window/bucket tests; verify via dev fallback (`READ_MODEL_DB_URL` unset).
3. Emit + verify wiring; `SCHEMA_VERSION 6`; full emit (hot-swap); verify green.
4. Reader + loader + `geo.ts`.
5. Carousel + ShowCard + `useNearbyShows`; integrate into home above other modules.
6. a11y/responsive pass; `vp check`.

## Risks

- Geocoder miss/wrong hit → ZIP fallback + state-match guard + 'failed' provenance; degrades to no-distance.
- Time-relative staleness → store all weekend buckets, reader picks by `now`.
- Pre-season emptiness → roll-forward to next weekend with shows.
- No IP geo → prompt-on-tap; date-order default.
- Schema desync → check live `.schema`, guarded `ADD COLUMN`, never `ensureRelationalSchema`.
