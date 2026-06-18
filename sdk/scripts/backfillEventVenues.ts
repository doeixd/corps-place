// Backfill event_venues from events + latest event_page_scrapes location fields.
// Usage: npx tsx scripts/backfillEventVenues.ts

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

type Row = {
  event_id: string;
  slug: string;
  name: string;
  event_name: string | null;
  venue_city: string | null;
  venue_state: string | null;
  location_city: string | null;
  location_state: string | null;
  location_text: string | null;
  location_address: string | null;
};

const clean = (value?: string | null) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
};

const normalizeKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const deriveVenueName = (row: Row) => {
  const address = clean(row.location_address);
  if (address) {
    const firstDigit = address.search(/\d/);
    if (firstDigit > 1) {
      const candidate = clean(address.slice(0, firstDigit));
      if (candidate && candidate.length >= 3) {
        return candidate;
      }
    }
  }

  const city = clean(row.venue_city) ?? clean(row.location_city);
  const state = clean(row.venue_state) ?? clean(row.location_state);
  if (city && state) {
    return `${city}, ${state}`;
  }

  return clean(row.location_text) ?? clean(row.event_name) ?? clean(row.name) ?? row.slug;
};

const deriveAddress = (row: Row) => {
  const fromScrape = clean(row.location_address);
  if (fromScrape) return fromScrape;

  const city = clean(row.venue_city) ?? clean(row.location_city);
  const state = clean(row.venue_state) ?? clean(row.location_state);
  if (city && state) return `${city}, ${state}`;
  return clean(row.location_text) ?? null;
};

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  const rows = yield* (
    sql<Row>`
      SELECT
        e.event_id,
        e.slug,
        e.name,
        e.event_name,
        e.venue_city,
        e.venue_state,
        e.location_city,
        e.location_state,
        eps.location_text,
        eps.location_address
      FROM events e
      LEFT JOIN (
        SELECT event_slug, MAX(scraped_at) AS max_scraped
        FROM event_page_scrapes
        GROUP BY event_slug
      ) latest
        ON latest.event_slug = e.slug
      LEFT JOIN event_page_scrapes eps
        ON eps.event_slug = latest.event_slug
       AND eps.scraped_at = latest.max_scraped
    `
  );

  let insertedOrUpdated = 0;
  for (const row of rows) {
    const venueName = deriveVenueName(row);
    if (!venueName) continue;

    const venueId = `${row.event_id}:${normalizeKey(venueName) || 'venue'}`;
    const address = deriveAddress(row);

    yield* (
      sql`
        INSERT INTO event_venues (
          venue_id,
          event_id,
          event_slug,
          name,
          address
        ) VALUES (
          ${venueId},
          ${row.event_id},
          ${row.slug},
          ${venueName},
          ${address}
        )
        ON CONFLICT(venue_id) DO UPDATE SET
          event_slug = excluded.event_slug,
          name = excluded.name,
          address = excluded.address
      `.pipe(Effect.asVoid)
    );
    insertedOrUpdated += 1;
  }

  const total = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) AS count
      FROM event_venues
    `.pipe(Effect.map((result) => result[0]?.count ?? 0))
  );

  console.log('event_venues backfill complete.');
  console.log(`  Rows processed: ${rows.length}`);
  console.log(`  Upserts:        ${insertedOrUpdated}`);
  console.log(`  Total rows:     ${total}`);
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('Backfill failed:', error);
  process.exitCode = 1;
});
