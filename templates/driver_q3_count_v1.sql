-- DRIVER Q3 COUNT
-- Parameters: $1=season, $2=driver_id
--
-- Returns: Q3 appearance count for a driver in a season
--
-- METHODOLOGY:
--   - Counts qualifying sessions where driver reached Q3 (set a Q3 time)
--   - Q3 = top 10 in qualifying
--   - A null eliminated_in_round means driver reached Q3
--
-- Output fields:
--   - driver_id: F1DB driver ID
--   - season: Season year
--   - q3_appearances: Number of Q3 appearances
--   - q2_eliminations: Number of Q2 eliminations (P11-P15)
--   - q1_eliminations: Number of Q1 eliminations (P16-P20)
--   - total_sessions: Total qualifying sessions entered
--   - q3_rate_percent: Percentage of sessions with Q3 appearance
--   - avg_qualifying_position: Average qualifying position

SELECT
  qr.driver_id,
  qr.season,
  COUNT(*) FILTER (WHERE qr.eliminated_in_round IS NULL) AS q3_appearances,
  COUNT(*) FILTER (WHERE qr.eliminated_in_round = 'Q2') AS q2_eliminations,
  COUNT(*) FILTER (WHERE qr.eliminated_in_round = 'Q1') AS q1_eliminations,
  COUNT(*) AS total_sessions,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE qr.eliminated_in_round IS NULL) / NULLIF(COUNT(*), 0),
    1
  ) AS q3_rate_percent,
  ROUND(AVG(qr.qualifying_position), 2) AS avg_qualifying_position
FROM qualifying_results qr
WHERE qr.season = $1
  AND qr.driver_id = $2
  AND qr.is_dns = FALSE
  AND qr.session_type = 'RACE_QUALIFYING'
GROUP BY qr.driver_id, qr.season;
