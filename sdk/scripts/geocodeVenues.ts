// Geocode event venues → fill event_venues.venue_latitude / venue_longitude
// (+ geocoded city/state for display) from the venue address.
//
// Why ZIP-centroid: event_venues.address is a smushed
// "<name><street><city>, ST ZIP" string with no delimiter between name/street/city,
// so geocode.maps.co returns [] for the full string. The trailing ", ST ZIP" is
// 100% parseable, and a ZIP-centroid lookup is reliable, returns the city/state,
// and is accurate to a few miles — plenty for a "show near me" sort.
//
// Usage (from sdk/, with GEOCODING_API_KEY in the repo-root .env):
//   npx tsx scripts/geocodeVenues.ts --dry-run            # current season (2026), no writes
//   npx tsx scripts/geocodeVenues.ts --year 2026          # apply for 2026
//   npx tsx scripts/geocodeVenues.ts --all                # every venue with an address
//   npx tsx scripts/geocodeVenues.ts --slug <event_slug>  # one event's venue(s)
//   npx tsx scripts/geocodeVenues.ts --year 2026 --refresh  # re-geocode even if coords exist
//
// Safe to re-run: idempotent (skips rows that already have coords unless --refresh),
// caches every geocode response in api_responses (cache-before-fetch), and respects
// the provider rate limit (5 req/sec, backing off to 1/sec on 429).

import { readFileSync } from "node:fs";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";

// --- Load repo-root .env (GEOCODING_API_KEY) without adding a dep. ---
for (const path of ["../.env", ".env"]) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
}

const GEOCODING_API_KEY = process.env.GEOCODING_API_KEY;
const GEOCODE_BASE = "https://geocode.maps.co/search";

// US bounding box (incl. AK/HI) — reject obviously-wrong hits.
const US_BBOX = { minLat: 18.0, maxLat: 72.0, minLng: -180.0, maxLng: -66.0 };

// --- CLI args ---
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const get = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY_RUN = has("--dry-run");
const REFRESH = has("--refresh");
const ALL = has("--all");
const SLUG = get("--slug");
const YEAR = get("--year") ?? (ALL || SLUG ? undefined : "2026");

// --- Pure: parse the trailing ", ST ZIP" out of a venue address. ---
export interface ParsedAddress {
  state: string;
  zip: string;
}
export const parseVenueAddress = (raw: string | null): ParsedAddress | null => {
  if (!raw) return null;
  const m = raw.match(/,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  if (!m) return null;
  return { state: m[1]!, zip: m[2]! };
};

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC",
]);
const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",
  illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",
  maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",
  pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA",
  "west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
};

interface GeocodeHit {
  lat: number;
  lng: number;
  city: string | null;
  state: string | null;
  raw: string;
}

// --- Geocode a query string, cached in api_responses. ---
const geocodeQuery = (sql: SqlClient.SqlClient, query: string) =>
  Effect.gen(function* () {
    const url = `${GEOCODE_BASE}?q=${encodeURIComponent(query)}&api_key=${GEOCODING_API_KEY}`;
    const cacheKey = `geocode:${query}`;

    const cached = yield* sql<{ response_json: string }>`
      SELECT response_json FROM api_responses WHERE endpoint_url = ${cacheKey} LIMIT 1
    `;
    let body: string;
    if (cached.length > 0) {
      body = cached[0]!.response_json;
    } else {
      body = yield* rateLimitedFetch(url);
      yield* sql`
        INSERT INTO api_responses (endpoint_url, endpoint_type, fetched_at, response_json, record_count)
        VALUES (${cacheKey}, 'geocode', ${new Date().toISOString()}, ${body}, NULL)
        ON CONFLICT(endpoint_url) DO UPDATE SET
          fetched_at = excluded.fetched_at, response_json = excluded.response_json
      `;
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as Array<Record<string, any>>,
      catch: () => new Error(`bad geocode JSON for ${query}`),
    }).pipe(Effect.orElseSucceed(() => [] as Array<Record<string, any>>));

    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const top = parsed[0]!;
    const lat = Number(top.lat);
    const lng = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const addr = (top.address ?? {}) as Record<string, string>;
    const city = addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.municipality ?? null;
    const stRaw = addr.state ?? null;
    const state = stRaw ? STATE_NAME_TO_ABBR[stRaw.toLowerCase()] ?? null : null;

    const hit: GeocodeHit = { lat, lng, city, state, raw: top.display_name ?? "" };
    return hit;
  });

// --- Rate-limited fetch: 5 req/sec target, 1 req/sec after a 429. ---
let spacingMs = 200; // 5/sec
let lastFetchAt = 0;
const rateLimitedFetch = (url: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const wait = Math.max(0, spacingMs - (Date.now() - lastFetchAt));
    if (wait > 0) yield* Effect.sleep(`${wait} millis`);
    lastFetchAt = Date.now();

    const res = yield* Effect.tryPromise({
      try: () => fetch(url, { headers: { "User-Agent": "corps-place/geocode" } }),
      catch: (e) => new Error(`geocode fetch failed: ${String(e)}`),
    });
    if (res.status === 429) {
      spacingMs = 1000; // back off to 1/sec for the rest of the run
      yield* Effect.sleep("2 seconds");
      return yield* rateLimitedFetch(url);
    }
    if (!res.ok) return yield* Effect.fail(new Error(`geocode HTTP ${res.status}`));
    return yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => new Error(`geocode read failed: ${String(e)}`),
    });
  });

interface VenueRow {
  venue_id: string;
  event_slug: string | null;
  name: string;
  address: string | null;
  venue_latitude: number | null;
}

const ensureColumns = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const cols = yield* sql<{ name: string }>`PRAGMA table_info(event_venues)`;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("geocode_source")) yield* sql`ALTER TABLE event_venues ADD COLUMN geocode_source TEXT`;
    if (!have.has("geocoded_at")) yield* sql`ALTER TABLE event_venues ADD COLUMN geocoded_at TEXT`;
    if (!have.has("geocode_city")) yield* sql`ALTER TABLE event_venues ADD COLUMN geocode_city TEXT`;
    if (!have.has("geocode_state")) yield* sql`ALTER TABLE event_venues ADD COLUMN geocode_state TEXT`;
  });

const main = Effect.gen(function* () {
  if (!GEOCODING_API_KEY) {
    yield* Effect.logError("GEOCODING_API_KEY not set (repo-root .env). Aborting.");
    return;
  }
  const sql = yield* SqlClient.SqlClient;

  if (!DRY_RUN) yield* ensureColumns(sql);

  // Select target venues.
  let rows: ReadonlyArray<VenueRow>;
  if (SLUG) {
    rows = yield* sql<VenueRow>`
      SELECT v.venue_id, v.event_slug, v.name, v.address, v.venue_latitude
      FROM event_venues v WHERE v.event_slug = ${SLUG}
    `;
  } else if (YEAR) {
    rows = yield* sql<VenueRow>`
      SELECT v.venue_id, v.event_slug, v.name, v.address, v.venue_latitude
      FROM event_venues v JOIN events e ON e.event_id = v.event_id
      WHERE e.year = ${YEAR}
    `;
  } else {
    rows = yield* sql<VenueRow>`
      SELECT v.venue_id, v.event_slug, v.name, v.address, v.venue_latitude
      FROM event_venues v WHERE v.address IS NOT NULL AND v.address != ''
    `;
  }

  let geocoded = 0, cachedSkip = 0, alreadyHad = 0, failed = 0, noAddress = 0;

  for (const row of rows) {
    if (row.venue_latitude != null && !REFRESH) {
      alreadyHad++;
      continue;
    }
    const parsed = parseVenueAddress(row.address);
    if (!parsed || !US_STATES.has(parsed.state)) {
      noAddress++;
      yield* Effect.logWarning(`no parseable ST ZIP: [${row.venue_id}] ${row.name} :: ${row.address}`);
      continue;
    }

    const hit = yield* geocodeQuery(sql, `${parsed.zip}, USA`);
    if (
      !hit ||
      hit.lat < US_BBOX.minLat || hit.lat > US_BBOX.maxLat ||
      hit.lng < US_BBOX.minLng || hit.lng > US_BBOX.maxLng ||
      (hit.state != null && hit.state !== parsed.state) // ZIP centroid disagrees with parsed state
    ) {
      failed++;
      yield* Effect.logWarning(
        `geocode failed/guarded: [${row.venue_id}] ${row.name} zip=${parsed.zip} st=${parsed.state} hit=${JSON.stringify(hit)}`
      );
      continue;
    }

    geocoded++;
    const city = hit.city;
    const state = hit.state ?? parsed.state;
    yield* Effect.log(
      `${DRY_RUN ? "[dry] " : ""}${row.name} → ${hit.lat.toFixed(4)},${hit.lng.toFixed(4)} (${city ?? "?"}, ${state})`
    );
    if (!DRY_RUN) {
      yield* sql`
        UPDATE event_venues SET
          venue_latitude = ${hit.lat},
          venue_longitude = ${hit.lng},
          geocode_source = 'zip',
          geocode_city = ${city},
          geocode_state = ${state},
          geocoded_at = ${new Date().toISOString()}
        WHERE venue_id = ${row.venue_id}
      `;
    }
  }

  yield* Effect.log(
    `\n=== geocodeVenues ${DRY_RUN ? "(DRY RUN) " : ""}===\n` +
      `scope: ${SLUG ? `slug=${SLUG}` : YEAR ? `year=${YEAR}` : "all"}\n` +
      `geocoded: ${geocoded}\nalready had coords (skipped): ${alreadyHad}\n` +
      `no parseable address: ${noAddress}\nfailed/guarded: ${failed}\n` +
      `total considered: ${rows.length}`
  );
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
