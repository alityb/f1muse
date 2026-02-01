-- race_results_summary_v1.sql
--
-- Returns race results from F1DB for a specific track and season.
-- Pure results only - no pace metrics, no extrapolation.
--
-- Parameters:
--   $1: season (INTEGER)
--   $2: track_id (TEXT) - F1DB circuit.id or grand_prix.id
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

SELECT
  r.year AS season,
  r.round,
  r.official_name AS race_name,
  r.date AS race_date,
  c.name AS circuit_name,
  rd.position_number AS position,
  d.id AS driver_id,
  d.full_name AS driver_name,
  con.name AS constructor_name,
  rd.race_laps AS laps_completed,
  COALESCE(rd.race_time, rd.race_gap, rd.race_reason_retired) AS race_time,
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
  AND (gp.id = $2 OR c.id = $2)
  AND rd.type IN ('RACE_RESULT', 'race')
ORDER BY
  rd.position_number ASC;
