import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Collapse split all-age division labels at the SOURCE (dci-relational.db).
//
// The DCI score-list/AJAX scrape tags DCA (all-age) corps with a generic
// "All Age Class", while recap pages give the specific "All-Age - World Class" /
// "All-Age - Open Class" / "All-Age - A Class". A corps that ends up with rows
// under BOTH a generic and a specific label appears TWICE in division-grouped
// rankings (e.g. Connecticut Hurricanes: 2024 specific, other years generic).
//
// Fix: map each affected corps's generic "All Age Class" rows onto the specific
// all-age class that same corps already uses elsewhere. Properties:
//   - idempotent (safe to run after every scrape; a no-op once clean)
//   - only touches corps that have BOTH labels (corps with only the generic
//     label are left alone — they don't double)
//   - deterministic: no corps has more than one distinct specific all-age label,
//     so the correlated subquery's LIMIT 1 is unambiguous
export const normalizeAllAgeDivisions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    UPDATE corps_scores
    SET division_name = (
      SELECT s.division_name FROM corps_scores s
      WHERE s.corps_key = corps_scores.corps_key
        AND s.division_name LIKE 'All-Age - %Class'
      LIMIT 1)
    WHERE division_name = 'All Age Class'
      AND EXISTS (
        SELECT 1 FROM corps_scores s2
        WHERE s2.corps_key = corps_scores.corps_key
          AND s2.division_name LIKE 'All-Age - %Class')
  `);
});

// Canonicalize lineup unit names via corps_aliases. The website scrape records a
// lineup unit under whatever name the page used (e.g. the alias "Hurricanes"),
// which then flows into prediction generation as a name-slug corps_key
// ("hurricanes") that won't merge with the scored corps in the diff view — and
// shows the wrong name on the lineup. Map exact alias matches to the canonical
// corps name. Idempotent; only touches exact alias_name matches (so compound
// units like "Encore - Hurricanes & Alumni" are untouched).
export const normalizeLineupAliases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    UPDATE event_lineup_entries
    SET unit_name = (
      SELECT a.canonical_name FROM corps_aliases a
      WHERE a.alias_name = event_lineup_entries.unit_name LIMIT 1)
    WHERE unit_name IN (SELECT alias_name FROM corps_aliases)
  `);
});

// Run all source-data canonicalizations. Call after any scrape and before any
// read-model emit so the relational DB (and the read-model it produces) stays
// free of alias/label splits.
export const normalizeIngestedData = Effect.gen(function* () {
  yield* normalizeAllAgeDivisions;
  yield* normalizeLineupAliases;
});
