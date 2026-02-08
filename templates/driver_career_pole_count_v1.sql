-- DRIVER CAREER POLE COUNT
-- Parameters: $1=driver_id
--
-- Returns: Career pole position statistics from F1DB driver table
--
-- METHODOLOGY:
--   - Uses F1DB driver table for authoritative career statistics
--   - total_pole_positions is pre-computed by F1DB (1950-present)
--   - Also provides supporting stats: races, wins, podiums for context
--
-- DEFINITION:
--   "Pole position" = official FIA definition = who starts P1 on the grid
--
-- Output fields:
--   - driver_id: F1DB driver ID
--   - driver_name: Full driver name
--   - total_poles: Career pole positions
--   - total_race_starts: Career race entries
--   - total_wins: Career race wins
--   - total_podiums: Career podiums
--   - pole_rate_percent: Career pole percentage
--   - first_season: First season in F1
--   - last_season: Most recent season in F1

WITH driver_seasons AS (
  SELECT
    MIN(year) AS first_season,
    MAX(year) AS last_season
  FROM season_driver_standing
  WHERE driver_id = $1 OR driver_id = REPLACE($1, '-', '_')
)
SELECT
  d.id AS driver_id,
  CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
  COALESCE(d.total_pole_positions, 0) AS total_poles,
  COALESCE(d.total_race_starts, 0) AS total_race_starts,
  COALESCE(d.total_race_wins, 0) AS total_wins,
  COALESCE(d.total_podiums, 0) AS total_podiums,
  COALESCE(d.total_championship_wins, 0) AS championships,
  CASE
    WHEN COALESCE(d.total_race_starts, 0) > 0
    THEN ROUND(100.0 * COALESCE(d.total_pole_positions, 0) / d.total_race_starts, 1)
    ELSE 0
  END AS pole_rate_percent,
  ds.first_season,
  ds.last_season
FROM driver d
LEFT JOIN driver_seasons ds ON TRUE
WHERE d.id = $1 OR d.id = REPLACE($1, '-', '_');
