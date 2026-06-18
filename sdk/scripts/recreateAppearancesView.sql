CREATE VIEW IF NOT EXISTS appearances AS
        WITH noise_keywords AS (
            SELECT 'gates open' AS kw UNION ALL SELECT 'intermission' UNION ALL
            SELECT 'anthem' UNION ALL SELECT 'scores announced' UNION ALL
            SELECT 'final scores' UNION ALL SELECT 'recognition' UNION ALL
            SELECT 'ceremony' UNION ALL SELECT 'age-out' UNION ALL
            SELECT 'age out' UNION ALL SELECT 'retreat' UNION ALL
            SELECT 'welcome' UNION ALL SELECT 'preshow' UNION ALL
            SELECT 'pre show' UNION ALL SELECT 'pre-show' UNION ALL
            SELECT 'announcement' UNION ALL SELECT 'encore' UNION ALL
            SELECT 'change' UNION ALL SELECT 'changeover' UNION ALL
            SELECT 'score' UNION ALL SELECT 'annouced' UNION ALL
            SELECT 'givaway' UNION ALL SELECT 'presentation' UNION ALL
            SELECT 'spectator' UNION ALL SELECT 'judges meeting'
        ),
        normalized_corps AS (
            SELECT
                co.corps_key, co.name, co.slug, co.division_name, co.active, co.corps_id,
                replace(replace(replace(replace(lower(co.name), ' ', ''), '-', ''), '&', ''), '.', '') AS normalized_name
            FROM corps co
            WHERE co.name NOT LIKE '%(%)%'
        ),
        raw_schedules AS (
            SELECT
                es.*,
                replace(replace(replace(replace(lower(es.unit_name), ' ', ''), '-', ''), '&', ''), '.', '') AS normalized_name
            FROM event_schedules es
            WHERE NOT EXISTS (
                SELECT 1 FROM noise_keywords nk
                WHERE LOWER(es.unit_name) = nk.kw
            )
        ),
        filtered_schedules AS (
            SELECT rs.*
            FROM raw_schedules rs
            WHERE
                EXISTS (SELECT 1 FROM normalized_corps nc WHERE rs.normalized_name = nc.normalized_name OR rs.normalized_name LIKE '%' || nc.normalized_name || '%')
                OR
                NOT EXISTS (SELECT 1 FROM noise_keywords nk WHERE lower(rs.unit_name) LIKE '%' || nk.kw || '%')
        ),
        matches AS (
            SELECT
                fs.*,
                nc.corps_key AS nc_corps_key, nc.name AS nc_name, nc.slug AS nc_slug, nc.division_name AS nc_division,
                ROW_NUMBER() OVER (
                    PARTITION BY fs.schedule_id
                    ORDER BY
                        (fs.normalized_name = nc.normalized_name) DESC,
                        nc.active DESC,
                        nc.corps_id IS NOT NULL DESC
                ) as match_priority
            FROM filtered_schedules fs
            LEFT JOIN normalized_corps nc ON
                fs.normalized_name = nc.normalized_name OR
                fs.normalized_name LIKE '%' || nc.normalized_name || '%'
        ),
        best_matches AS (
            SELECT * FROM matches WHERE match_priority = 1
        )
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
          bm.schedule_id AS lineup_id,
          bm.time AS performance_time,
          bm.unit_name AS lineup_unit_name,
          bm.display_city AS lineup_display_city,
          bm.nc_corps_key AS corps_key,
          COALESCE(cs.corps_name, bm.nc_name, bm.unit_name) AS group_name,
          COALESCE(sp.division, cs.division_name, bm.nc_division) AS division_name,
          cs.total_score AS total_score,
          cs.subtotal_score AS subtotal_score,
          cs.rank AS rank,
          cs.round AS round,
          COALESCE(
            bm.performance_order,
            ele.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY e.slug
              ORDER BY bm.time IS NULL, bm.time, bm.schedule_id
            )
          ) AS performance_order_overall,
          COALESCE(
            bm.performance_order,
            ele.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY e.slug, COALESCE(sp.division, cs.division_name, bm.nc_division)
              ORDER BY bm.time IS NULL, bm.time, bm.schedule_id
            )
          ) AS performance_order_in_class,
          COUNT(*) OVER (
            PARTITION BY e.slug, COALESCE(sp.division, cs.division_name, bm.nc_division)
          ) AS number_of_performers_in_class
        FROM best_matches bm
        JOIN events e ON e.event_id = bm.event_id
        LEFT JOIN competitions c ON c.slug = e.slug
        LEFT JOIN corps_scores cs
          ON cs.competition_slug = e.slug
         AND (cs.corps_key = bm.nc_corps_key OR cs.corps_name = bm.unit_name)
        LEFT JOIN season_participation_view sp ON sp.season = e.season AND sp.corps_key = bm.nc_corps_key
        LEFT JOIN event_lineup_entries ele ON ele.event_slug = e.slug AND LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) = LOWER(REPLACE(REPLACE(bm.unit_name, ' ', ''), '-', ''));
