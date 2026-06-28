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
