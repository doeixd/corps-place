// City-centroid fallback geocoding for events whose venue rows have no
// parseable address (the ZIP-centroid pass in geocodeVenues.ts covers the
// rest). Accuracy is city-level — consistent with the ZIP-centroid approach
// the tour map already labels "approximate". Fills 2025's 40 missing events
// (and ~164 across modern seasons).
//
// Usage (from sdk/): npx tsx scripts/geocodeEventCities.ts [--dry-run] [--year YYYY]
// Idempotent: only touches events with NO geocoded venue; responses cached in
// api_responses; same 5/sec→1/sec rate limiting as geocodeVenues.

import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

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

const API_KEY = process.env.GEOCODING_API_KEY;
const BASE = "https://geocode.maps.co/search";
const DRY = process.argv.includes("--dry-run");
const yearIdx = process.argv.indexOf("--year");
const YEAR = yearIdx >= 0 ? process.argv[yearIdx + 1] : undefined;
const US = { minLat: 18.0, maxLat: 72.0, minLng: -180.0, maxLng: -66.0 };

const db = createClient({ url: "file:./dci-relational.db" });

let spacing = 200;
let lastAt = 0;
async function fetchLimited(url: string): Promise<string> {
  const wait = Math.max(0, spacing - (Date.now() - lastAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": "corps-place/geocode" } });
  if (res.status === 429) {
    spacing = 1000;
    await new Promise((r) => setTimeout(r, 2000));
    return fetchLimited(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function geocodeCity(city: string, state: string) {
  const q = `${city}, ${state}, USA`;
  const cacheKey = `geocode:${q}`;
  const cached = await db.execute({
    sql: "SELECT response_json FROM api_responses WHERE endpoint_url = ? LIMIT 1",
    args: [cacheKey],
  });
  let body: string;
  if (cached.rows.length) body = String(cached.rows[0]!.response_json);
  else {
    body = await fetchLimited(`${BASE}?q=${encodeURIComponent(q)}&api_key=${API_KEY}`);
    await db.execute({
      sql: `INSERT INTO api_responses (endpoint_url, endpoint_type, fetched_at, response_json, record_count)
            VALUES (?, 'geocode', ?, ?, NULL)
            ON CONFLICT(endpoint_url) DO UPDATE SET fetched_at=excluded.fetched_at, response_json=excluded.response_json`,
      args: [cacheKey, new Date().toISOString(), body],
    });
  }
  try {
    const arr = JSON.parse(body) as Array<{ lat?: string; lon?: string }>;
    const top = arr?.[0];
    const lat = Number(top?.lat);
    const lng = Number(top?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < US.minLat || lat > US.maxLat || lng < US.minLng || lng > US.maxLng) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

async function main() {
  if (!API_KEY) throw new Error("GEOCODING_API_KEY not set");
  const rows = await db.execute({
    sql: `SELECT e.event_id, e.slug, e.location_city AS city, e.location_state AS state,
                 (SELECT venue_id FROM event_venues v WHERE v.event_slug = e.slug LIMIT 1) AS venue_id
            FROM events e
           WHERE e.location_city IS NOT NULL AND e.location_city != ''
             AND e.location_state IS NOT NULL AND length(e.location_state) = 2
             ${YEAR ? "AND (e.season = ? OR e.start_date LIKE ?)" : ""}
             AND NOT EXISTS (
               SELECT 1 FROM event_venues ev
                WHERE ev.event_slug = e.slug AND ev.venue_latitude IS NOT NULL)`,
    args: YEAR ? [YEAR, `${YEAR}%`] : [],
  });
  let ok = 0,
    miss = 0;
  for (const r of rows.rows as unknown as {
    event_id: string;
    slug: string;
    city: string;
    state: string;
    venue_id: string | null;
  }[]) {
    const hit = await geocodeCity(r.city, r.state);
    if (!hit) {
      miss++;
      console.log(`  MISS ${r.slug} (${r.city}, ${r.state})`);
      continue;
    }
    ok++;
    if (DRY) continue;
    const now = new Date().toISOString();
    if (r.venue_id) {
      await db.execute({
        sql: `UPDATE event_venues SET venue_latitude=?, venue_longitude=?, geocode_city=?,
                geocode_state=?, geocode_source='city-centroid', geocoded_at=? WHERE venue_id=?`,
        args: [hit.lat, hit.lng, r.city, r.state, now, r.venue_id],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO event_venues (venue_id, event_id, event_slug, name, address,
                venue_latitude, venue_longitude, geocode_city, geocode_state,
                geocode_source, geocoded_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'city-centroid', ?)`,
        args: [
          `city:${r.slug}`,
          r.event_id,
          r.slug,
          `${r.city}, ${r.state}`,
          hit.lat,
          hit.lng,
          r.city,
          r.state,
          now,
        ],
      });
    }
  }
  console.log(`${DRY ? "DRY RUN — " : ""}geocoded ${ok}, missed ${miss}, of ${rows.rows.length}`);
  db.close();
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
