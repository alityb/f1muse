-- race_results_summary_v1.sql
--
-- Returns race results from F1DB for a specific track and season.
-- Pure results only - no pace metrics, no extrapolation.
--
-- Parameters:
--   $1: season (INTEGER)
--   $2: track_id (TEXT) - Accepts multiple formats:
--       - F1DB circuit.id (e.g., 'monaco')
--       - F1DB grand_prix.id (e.g., 'monaco-grand-prix')
--       - laps_normalized format (e.g., 'monaco_grand_prix')
--       - Common track names (e.g., 'silverstone', 'spa')
--
-- Returns:
--   - season
--   - round
--   - race_name
--   - race_date
--   - circuit_name
--   - position
--   - driver_id
--   - driver_name
--   - constructor_name
--   - laps_completed
--   - race_time (winner's time or time/gap)
--   - fastest_lap
--   - grid_position
--   - points

WITH track_alias AS (
  SELECT * FROM (VALUES
    ('silverstone', 'great-britain'),
    ('british', 'great-britain'),
    ('monza', 'italy'),
    ('italian', 'italy'),
    ('spa', 'belgium'),
    ('belgian', 'belgium'),
    ('suzuka', 'japan'),
    ('japanese', 'japan'),
    ('interlagos', 'brazil'),
    ('sao paulo', 'brazil'),
    ('brazilian', 'brazil'),
    ('albert park', 'australia'),
    ('melbourne', 'australia'),
    ('australian', 'australia'),
    ('marina bay', 'singapore'),
    ('singapore', 'singapore'),
    ('yas marina', 'abu-dhabi'),
    ('abu dhabi', 'abu-dhabi'),
    ('circuit of the americas', 'united-states'),
    ('cota', 'united-states'),
    ('austin', 'united-states'),
    ('american', 'united-states'),
    ('las vegas', 'las-vegas'),
    ('jeddah', 'saudi-arabia'),
    ('saudi', 'saudi-arabia'),
    ('losail', 'qatar'),
    ('zandvoort', 'netherlands'),
    ('dutch', 'netherlands'),
    ('hungaroring', 'hungary'),
    ('hungarian', 'hungary'),
    ('red bull ring', 'austria'),
    ('spielberg', 'austria'),
    ('austrian', 'austria'),
    ('barcelona', 'spain'),
    ('catalunya', 'spain'),
    ('spanish', 'spain'),
    ('baku', 'azerbaijan'),
    ('shanghai', 'china'),
    ('chinese', 'china'),
    ('sakhir', 'bahrain'),
    ('miami', 'miami'),
    ('imola', 'emilia-romagna'),
    ('portimao', 'portugal'),
    ('paul ricard', 'france'),
    ('le castellet', 'france'),
    ('french', 'france'),
    ('mexican', 'mexico'),
    ('monaco', 'monaco'),
    ('canadian', 'canada'),
    ('montreal', 'canada')
  ) AS t(alias, canonical)
)
SELECT
  r.year AS season,
  r.round,
  r.official_name AS race_name,
  r.date AS race_date,
  c.name AS circuit_name,
  rd.position_number AS position,
  d.id AS driver_id,
  CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
  con.name AS constructor_name,
  rd.race_laps AS laps_completed,
  -- P1 gets full race time, P2+ get gap from leader (or laps behind, or DNF reason)
  CASE
    WHEN rd.position_number = 1 THEN rd.race_time
    ELSE COALESCE(rd.race_gap, rd.race_reason_retired, 'N/A')
  END AS race_time,
  rd.fastest_lap_time AS fastest_lap,
  rd.race_grid_position_number AS grid_position,
  rd.race_points AS points
FROM
  race r
  INNER JOIN grand_prix gp ON r.grand_prix_id = gp.id
  INNER JOIN circuit c ON r.circuit_id = c.id
  INNER JOIN race_data rd ON r.id = rd.race_id
  INNER JOIN driver d ON rd.driver_id = d.id
  INNER JOIN constructor con ON rd.constructor_id = con.id
WHERE
  r.year = $1
  AND (
    -- Direct match on grand_prix.id
    gp.id = $2
    OR gp.id = REPLACE($2, '_', '-')
    -- Direct match on circuit.id
    OR c.id = $2
    OR c.id = SPLIT_PART(REPLACE($2, '_', '-'), '-grand-prix', 1)
    -- Partial match (case-insensitive) - only if input looks like a track name (not grand-prix format)
    OR (LOWER($2) NOT LIKE '%grand%prix%' AND LOWER(gp.id) LIKE CONCAT('%', LOWER(REPLACE($2, '_', '-')), '%'))
    OR (LOWER($2) NOT LIKE '%grand%prix%' AND LOWER(c.id) LIKE CONCAT('%', LOWER(REPLACE($2, '_', '-')), '%'))
    -- Match via track alias (e.g., silverstone -> great-britain) - only if alias exists
    OR gp.id = (SELECT canonical FROM track_alias WHERE LOWER($2) LIKE CONCAT('%', alias, '%') LIMIT 1)
    OR (EXISTS (SELECT 1 FROM track_alias WHERE LOWER($2) LIKE CONCAT('%', alias, '%'))
        AND LOWER(gp.id) LIKE CONCAT('%', (SELECT canonical FROM track_alias WHERE LOWER($2) LIKE CONCAT('%', alias, '%') LIMIT 1), '%'))
  )
  AND rd.type IN ('RACE_RESULT', 'race')
ORDER BY
  rd.position_number ASC;
