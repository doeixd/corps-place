-- Fixed appearances view that includes ALL scored corps, not just those with schedule entries
DROP VIEW IF EXISTS appearances;

CREATE VIEW appearances AS
  -- Start from corps_scores to ensure all scored corps are included
  SELECT
    e.slug AS event_slug,
    e.event_id AS event_id,
    e.name AS event_name,
    e.start_date AS event_start_date,
    e.start_time AS event_start_time,
    e.edt_start_time AS event_edt_start_time,
    e.location_city AS location_city,
    e.location_state AS location_state,
    e.venue_city AS venue_city,
    e.venue_state AS venue_state,
    e.timezone AS timezone,
    c.slug AS competition_slug,
    c.event_name AS competition_event_name,
    c.date AS competition_date,
    c.season AS season,
    c.competition_level AS competition_level,
    c.scores_released AS scores_released,
    c.recap_released AS recap_released,
    c.category_recap_released AS category_recap_released,
    c.slug AS recap_id,
    es.schedule_id AS lineup_id,
    es.time AS performance_time,
    COALESCE(es.unit_name, cs.corps_name, co.name) AS lineup_unit_name,
    es.display_city AS lineup_display_city,
    cs.corps_key AS corps_key,
    cs.corps_name AS group_name,
    cs.division_name AS division_name,
    cs.total_score AS total_score,
    cs.subtotal_score AS subtotal_score,
    cs.rank AS rank,
    cs.round AS round,
    -- Performance order: prioritize explicit order from lineup_entries, then participants, then event_schedules, fallback to ROW_NUMBER
    COALESCE(
      ele.performance_order,
      ep.performance_order,
      es.performance_order,
      ROW_NUMBER() OVER (
        PARTITION BY e.slug
        ORDER BY es.time IS NULL, es.time, cs.corps_key
      )
    ) AS performance_order_overall,
    COALESCE(
      ele.performance_order,
      ep.performance_order,
      es.performance_order,
      ROW_NUMBER() OVER (
        PARTITION BY e.slug, cs.division_name
        ORDER BY es.time IS NULL, es.time, cs.corps_key
      )
    ) AS performance_order_in_class,
    COUNT(*) OVER (
      PARTITION BY e.slug, cs.division_name
    ) AS number_of_performers_in_class
  FROM corps_scores cs
  JOIN competitions c ON c.slug = cs.competition_slug
  JOIN events e ON e.slug = c.slug
  LEFT JOIN corps co ON co.corps_key = cs.corps_key
  -- LEFT JOIN to event_schedules so we don't lose corps without schedule entries
  LEFT JOIN event_schedules es
    ON es.event_id = e.event_id
    AND (
      LOWER(REPLACE(REPLACE(es.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(cs.corps_name, ' ', ''), '-', ''))
      OR LOWER(REPLACE(REPLACE(es.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(co.name, ' ', ''), '-', ''))
    )
  -- LEFT JOIN to event_lineup_entries for explicit performance_order
  LEFT JOIN event_lineup_entries ele
    ON ele.event_slug = e.slug
    AND (
      LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(cs.corps_name, ' ', ''), '-', ''))
      OR LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(co.name, ' ', ''), '-', ''))
    )
  -- LEFT JOIN to event_participants for explicit performance_order
  LEFT JOIN event_participants ep
    ON ep.event_slug = e.slug
    AND ep.corps_key = cs.corps_key;
