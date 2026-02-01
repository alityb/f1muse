-- SEASON Q3 RANKINGS
-- Parameters: $1=season
--
-- Returns: All drivers ranked by Q3 appearances in a season
--
-- METHODOLOGY:
--   - Uses qualifying_results_official view for FIA-accurate grid positions
--   - Counts Q3 appearances for each driver
--   - Ranks by Q3 count descending
--   - Includes team affiliation and qualifying stats
--
-- Output fields:
--   - rank: Position in Q3 ranking (1 = most Q3 appearances)
--   - driver_id: F1DB driver ID
--   - team_id: F1DB constructor ID
--   - q3_appearances: Number of Q3 appearances
--   - q2_eliminations: Number of Q2 eliminations
--   - q1_eliminations: Number of Q1 eliminations
--   - total_sessions: Total qualifying sessions
--   - q3_rate_percent: Percentage of sessions with Q3
--   - pole_count: Number of official poles (P1 on grid)
--   - fastest_time_count: Number of fastest qualifying times
--   - avg_grid_position: Average official starting grid position
--   - avg_qualifying_position: Average qualifying classification position

WITH driver_stats AS (
  SELECT
    qro.driver_id,
    qro.team_id,
    COUNT(*) FILTER (WHERE qro.eliminated_in_round IS NULL) AS q3_appearances,
    COUNT(*) FILTER (WHERE qro.eliminated_in_round = 'Q2') AS q2_eliminations,
    COUNT(*) FILTER (WHERE qro.eliminated_in_round = 'Q1') AS q1_eliminations,
    COUNT(*) AS total_sessions,
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE qro.eliminated_in_round IS NULL) / NULLIF(COUNT(*), 0),
      1
    ) AS q3_rate_percent,
    COUNT(*) FILTER (WHERE qro.official_grid_position = 1) AS pole_count,
    COUNT(*) FILTER (WHERE qro.qualifying_position = 1) AS fastest_time_count,
    ROUND(AVG(qro.official_grid_position), 2) AS avg_grid_position,
    ROUND(AVG(qro.qualifying_position), 2) AS avg_qualifying_position
  FROM qualifying_results_official qro
  WHERE qro.season = $1
    AND qro.is_dns = FALSE
  GROUP BY qro.driver_id, qro.team_id
)
SELECT
  ROW_NUMBER() OVER (ORDER BY ds.q3_appearances DESC, ds.pole_count DESC, ds.avg_grid_position ASC) AS rank,
  ds.driver_id,
  ds.team_id,
  ds.q3_appearances,
  ds.q2_eliminations,
  ds.q1_eliminations,
  ds.total_sessions,
  ds.q3_rate_percent,
  ds.pole_count,
  ds.fastest_time_count,
  ds.avg_grid_position,
  ds.avg_qualifying_position
FROM driver_stats ds
ORDER BY rank;
