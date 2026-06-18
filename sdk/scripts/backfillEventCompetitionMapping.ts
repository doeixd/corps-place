// scripts/backfillEventCompetitionMapping.ts
// Backfills the event_to_competition mapping table for existing data.
// This resolves the slug mismatch between events (from DCI website) and
// competitions (from DCI API) so scores/recaps can be found from either slug.
//
// Usage: npx tsx scripts/backfillEventCompetitionMapping.ts [--dry-run]
//
// The script:
// 1. Finds events without a mapping
// 2. Tries to match each to a competition by date + name
// 3. Falls back to name-only match if date match fails
// 4. Reports what would be inserted (or inserts with --apply)

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import { createClient } from '@libsql/client';
import path from 'path';

const dbUrl = () =>
  process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(process.cwd(), 'dci-relational.db')}`;

interface EventRow {
  slug: string;
  name: string;
  event_name: string | null;
  start_date: string;
}

interface CompetitionRow {
  slug: string;
  event_name: string;
  date: string;
}

const normalize = (s: string) => s.trim().toLowerCase();

// Season = the calendar year of the event. Derive it from start_date (correct for
// BOTH bare slugs like "brass-impact" and prefixed slugs like "2022-…"); only fall
// back to a slug prefix that already looks like a year. Using slug.split('-')[0]
// alone was wrong for bare events (it returned the first word, e.g. "brass").
const seasonOf = (event: { slug: string; start_date: string }): string => {
  const fromDate = (event.start_date ?? '').slice(0, 4);
  if (/^\d{4}$/.test(fromDate)) return fromDate;
  const fromSlug = event.slug.split('-')[0];
  return /^\d{4}$/.test(fromSlug) ? fromSlug : '';
};

const matchByDateAndName = (
  event: EventRow,
  competitions: CompetitionRow[]
): CompetitionRow | null => {
  const eventDate = event.start_date.split('T')[0];
  const eventSeason = seasonOf(event);
  const eventName = normalize(event.event_name ?? event.name);

  // First try: exact date + name match. Season MUST agree — a cross-season
  // fallback once produced a bad mapping (2023-…-night-package → 2024-…).
  // Recurring annual events share a date-less name and even a calendar date can
  // recur across years, so never accept a different season.
  const sameSeasonMatches: CompetitionRow[] = [];

  for (const comp of competitions) {
    const compDate = comp.date.split('T')[0];
    const compName = normalize(comp.event_name);
    const compSeason = comp.slug.split('-')[0];

    if (compDate === eventDate && compName === eventName && compSeason === eventSeason) {
      sameSeasonMatches.push(comp);
    }
  }

  if (sameSeasonMatches.length > 0) return sameSeasonMatches[0];

  // Second try: date match with partial name match (handles "Finals" suffix
  // differences) — still same-season only.
  for (const comp of competitions) {
    const compDate = comp.date.split('T')[0];
    const compName = normalize(comp.event_name);
    const compSeason = comp.slug.split('-')[0];

    if (compDate === eventDate && compSeason === eventSeason) {
      // Check if one name contains the other (handles "Championship" vs "Championship Finals")
      if (compName.includes(eventName) || eventName.includes(compName)) {
        return comp;
      }
      // Check if the core name matches (strip common suffixes)
      const eventCore = eventName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
      const compCore = compName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
      if (eventCore === compCore && eventCore.length > 10) {
        return comp;
      }
    }
  }

  return null;
};

const matchByNameOnly = (
  event: EventRow,
  competitions: CompetitionRow[]
): CompetitionRow | null => {
  const eventName = normalize(event.event_name ?? event.name);
  const eventSeason = seasonOf(event);

  // Try exact name match, preferring same season
  const sameSeasonExact: CompetitionRow[] = [];
  const otherSeasonExact: CompetitionRow[] = [];

  for (const comp of competitions) {
    const compName = normalize(comp.event_name);
    const compSeason = comp.slug.split('-')[0];

    if (compName === eventName) {
      if (compSeason === eventSeason) {
        sameSeasonExact.push(comp);
      } else {
        otherSeasonExact.push(comp);
      }
    }
  }

  if (sameSeasonExact.length > 0) return sameSeasonExact[0];

  // Try with suffix stripping, preferring same season
  const eventCore = eventName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
  if (eventCore.length <= 10) return null; // Too short to be reliable

  const sameSeasonCore: CompetitionRow[] = [];
  const otherSeasonCore: CompetitionRow[] = [];

  for (const comp of competitions) {
    const compName = normalize(comp.event_name);
    const compCore = compName.replace(/\s*(finals?|prelims?|semifinals?)\s*$/i, '').trim();
    const compSeason = comp.slug.split('-')[0];

    if (eventCore === compCore) {
      if (compSeason === eventSeason) {
        sameSeasonCore.push(comp);
      } else {
        otherSeasonCore.push(comp);
      }
    }
  }

  if (sameSeasonCore.length > 0) return sameSeasonCore[0];
  // Don't fall back to other seasons for name-only matches — too risky
  return null;
};

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--apply');

  if (dryRun) {
    console.log('Running in DRY RUN mode. Use --apply to write changes.\n');
  }

  const db = createClient({ url: dbUrl() });

  try {
    // Ensure the mapping table exists
    yield* Effect.tryPromise(() =>
      db.execute({
        sql: `CREATE TABLE IF NOT EXISTS event_to_competition (
          event_slug TEXT PRIMARY KEY,
          competition_slug TEXT NOT NULL,
          match_method TEXT NOT NULL DEFAULT 'heuristic',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
        args: [],
      })
    );

    // Get all events without a mapping
    const unmappedEvents = yield* Effect.tryPromise(() =>
      db.execute({
        sql: `SELECT e.slug, e.name, e.event_name, e.start_date
              FROM events e
              LEFT JOIN event_to_competition m ON m.event_slug = e.slug
              WHERE m.event_slug IS NULL
              ORDER BY e.start_date DESC`,
        args: [],
      })
    );

    const events = unmappedEvents.rows as unknown as EventRow[];
    console.log(`Found ${events.length} events without a mapping.\n`);

    if (events.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // Get all competitions
    const allCompetitions = yield* Effect.tryPromise(() =>
      db.execute({
        sql: `SELECT slug, event_name, date FROM competitions ORDER BY date DESC`,
        args: [],
      })
    );

    const competitions = allCompetitions.rows as unknown as CompetitionRow[];
    console.log(`Loaded ${competitions.length} competitions for matching.\n`);

    // Match each event
    const matches: { event: EventRow; competition: CompetitionRow; method: string }[] = [];
    const unmatched: EventRow[] = [];

    // Exact-slug identity is the strongest signal: when a competition shares the
    // event's slug, that IS the competition — never let a fuzzy date+name match
    // steal it for a same-name sibling (e.g. the two nights of "DCI Eastern
    // Classic" cross-linking to each other).
    const compBySlug = new Map(competitions.map((c) => [c.slug, c]));

    for (const event of events) {
      const exact = compBySlug.get(event.slug);
      if (exact) {
        matches.push({ event, competition: exact, method: 'exact-slug' });
        continue;
      }

      const dateMatch = matchByDateAndName(event, competitions);
      if (dateMatch) {
        matches.push({ event, competition: dateMatch, method: 'date+name' });
        continue;
      }

      const nameMatch = matchByNameOnly(event, competitions);
      if (nameMatch) {
        matches.push({ event, competition: nameMatch, method: 'name-only' });
        continue;
      }

      unmatched.push(event);
    }

    // Report results
    console.log(`\n=== Matching Results ===`);
    console.log(`Matched: ${matches.length}`);
    console.log(`Unmatched: ${unmatched.length}`);

    if (matches.length > 0) {
      console.log(`\n--- Matches (${matches.length}) ---`);
      for (const { event, competition, method } of matches.slice(0, 20)) {
        console.log(
          `  ${event.slug}\n    -> ${competition.slug} (${method})`
        );
      }
      if (matches.length > 20) {
        console.log(`  ... and ${matches.length - 20} more`);
      }
    }

    if (unmatched.length > 0) {
      console.log(`\n--- Unmatched Events (${unmatched.length}) ---`);
      for (const event of unmatched.slice(0, 10)) {
        console.log(`  ${event.slug} (${event.event_name ?? event.name})`);
      }
      if (unmatched.length > 10) {
        console.log(`  ... and ${unmatched.length - 10} more`);
      }
    }

    // Apply if requested
    if (!dryRun && matches.length > 0) {
      console.log(`\n=== Applying ${matches.length} mappings ===`);

      for (const { event, competition, method } of matches) {
        yield* Effect.tryPromise(() =>
          db.execute({
            sql: `INSERT INTO event_to_competition (event_slug, competition_slug, match_method)
                  VALUES (?, ?, ?)
                  ON CONFLICT(event_slug) DO UPDATE SET
                    competition_slug = excluded.competition_slug,
                    match_method = excluded.match_method`,
            args: [event.slug, competition.slug, method],
          })
        );
      }

      console.log(`Done! Inserted ${matches.length} mappings.`);
    } else if (dryRun) {
      console.log(`\n(Dry run — no changes written)`);
    }
  } finally {
    db.close();
  }
});

Effect.runPromise(main).catch((err) => {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
