// Single source of truth for the lineup-derived notion of an "active" corps,
// shared by the read-model builders (and re-exported to the app).
//
// Canonical definition: a corps is **competing in a season** iff it appears in a
// scored, non-exhibition lineup for that season — i.e. it has a row in the
// `scored_event_lineup` view (which already strips exhibition / legacy / alumni
// units) joined to an event in that season. This is the definition the directory
// uses for its `active` flag and the corps page uses to decide whether to show a
// season prediction. Keeping it here means those two can't silently diverge (the
// drift that let a hiatus corps look inactive in the directory yet still carry a
// prediction).
//
// These are raw-SQL fragments because the corps-directory queries are libsql
// string SQL, not an ORM. Compose them into a `WITH …` clause or a `WHERE`.

/**
 * CTE resolving the latest season that has any lineup data. Roll-over is
 * automatic: as a new season's lineups land, `MAX(e.season)` advances.
 * Exposes one column `season` via the name `current_season`.
 *
 * Sourced from the raw `event_lineup_entries` rather than the `scored_event_lineup`
 * view: we only need the newest season *with lineups*, and the view's exclusion-
 * pattern matching makes MAX(season) ~40x slower (~177ms vs ~4ms) for an identical
 * answer. The only divergence would be a rollover where the newest season has
 * *only* exhibition/excluded lineups loaded — a transient state that self-corrects
 * once real (scored) lineups land, and `active_corps` is empty for it either way.
 */
export const LATEST_LINEUP_SEASON_CTE = `current_season AS (
  SELECT MAX(e.season) AS season
  FROM event_lineup_entries ele
  JOIN events e ON e.slug = ele.event_slug
)`;

/**
 * CTE of the distinct `corps_key`s competing in the latest lineup season.
 * Depends on {@link LATEST_LINEUP_SEASON_CTE} being present in the same `WITH`.
 * Exposes one column `corps_key` via the name `active_corps`.
 */
export const ACTIVE_CORPS_CTE = `active_corps AS (
  SELECT DISTINCT sel.corps_key
  FROM scored_event_lineup sel
  JOIN events e ON e.slug = sel.event_slug
  JOIN current_season cs ON e.season = cs.season
)`;

/**
 * EXISTS predicate testing whether `corpsKeyExpr` competes in a season. Binds a
 * single `?` parameter (the season) — append it to the statement's args in order.
 *
 * @param corpsKeyExpr SQL expression for the corps key to test, e.g. `'c.corps_key'`.
 */
export const corpsCompetesInSeasonExists = (corpsKeyExpr: string) => `EXISTS (
  SELECT 1 FROM scored_event_lineup sel
  JOIN events ev ON ev.slug = sel.event_slug
  WHERE ev.season = ? AND sel.corps_key = ${corpsKeyExpr}
)`;
