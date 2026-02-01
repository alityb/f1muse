-- DRIVER POLE COUNT
-- Parameters: $1=season, $2=driver_id
--
-- Returns: Official pole position count for a driver in a season
--
-- METHODOLOGY:
--   - Uses qualifying_results_official view for FIA-accurate grid positions
--   - Counts OFFICIAL poles (who started P1 on the grid)
--   - Returns 0 if no poles (not null)
--   - ONLY counts race qualifying (excludes sprint qualifying)
--
-- DEFINITION:
--   "Pole position" = official FIA definition = who starts P1 on the grid
--   NOT "fastest qualifying time" (which may differ due to grid penalties)
--
-- Output fields:
--   - driver_id: F1DB driver ID
--   - season: Season year
--   - pole_count: Number of official pole positions (race qualifying only)
--   - fastest_time_count: Number of times set fastest qualifying time
--   - total_sessions: Total race qualifying sessions entered
--   - pole_rate_percent: Percentage of sessions with official pole
--   - front_row_count: Number of P1 or P2 official grid starts
--   - top_3_count: Number of P1, P2, or P3 official grid starts
--   - avg_grid_position: Average official starting grid position
--   - best_grid_position: Best (lowest) official grid position
--   - avg_qualifying_position: Average qualifying classification position
--   - best_qualifying_position: Best (lowest) qualifying classification position

SELECT
  qro.driver_id,
  qro.season,
  COUNT(*) FILTER (WHERE qro.official_grid_position = 1) AS pole_count,
  COUNT(*) FILTER (WHERE qro.qualifying_position = 1) AS fastest_time_count,
  COUNT(*) AS total_sessions,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE qro.official_grid_position = 1) / NULLIF(COUNT(*), 0),
    1
  ) AS pole_rate_percent,
  COUNT(*) FILTER (WHERE qro.official_grid_position <= 2) AS front_row_count,
  COUNT(*) FILTER (WHERE qro.official_grid_position <= 3) AS top_3_count,
  ROUND(AVG(qro.official_grid_position), 2) AS avg_grid_position,
  MIN(qro.official_grid_position) AS best_grid_position,
  ROUND(AVG(qro.qualifying_position), 2) AS avg_qualifying_position,
  MIN(qro.qualifying_position) AS best_qualifying_position
FROM qualifying_results_official qro
WHERE qro.season = $1
  AND qro.driver_id = $2
  AND qro.is_dns = FALSE
GROUP BY qro.driver_id, qro.season;
