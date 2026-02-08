-- qualifying_results_summary_v1.sql
--
-- Returns qualifying results for a specific track and season.
-- Shows grid positions and qualifying times.
--
-- Parameters:
--   $1: season (INTEGER)
--   $2: track_id (TEXT) - Already resolved by TrackResolver (e.g., 'british_grand_prix')
--
-- Returns qualifying grid with P1 showing full time, P2+ showing gap

WITH
qualifying_data AS (
  SELECT
    qr.season,
    qr.round,
    qr.track_id,
    qr.qualifying_position AS position,
    qr.driver_id,
    CONCAT(d.first_name, ' ', d.last_name) AS driver_name,
    con.name AS constructor_name,
    -- Format Q1 time as M:SS.sss
    CASE WHEN qr.q1_time_ms IS NOT NULL
      THEN CONCAT(
        FLOOR(qr.q1_time_ms / 60000)::TEXT, ':',
        LPAD(FLOOR((qr.q1_time_ms % 60000) / 1000)::TEXT, 2, '0'), '.',
        LPAD((qr.q1_time_ms % 1000)::TEXT, 3, '0')
      )
      ELSE NULL
    END AS q1_time,
    -- Format Q2 time as M:SS.sss
    CASE WHEN qr.q2_time_ms IS NOT NULL
      THEN CONCAT(
        FLOOR(qr.q2_time_ms / 60000)::TEXT, ':',
        LPAD(FLOOR((qr.q2_time_ms % 60000) / 1000)::TEXT, 2, '0'), '.',
        LPAD((qr.q2_time_ms % 1000)::TEXT, 3, '0')
      )
      ELSE NULL
    END AS q2_time,
    -- Format Q3 time as M:SS.sss
    CASE WHEN qr.q3_time_ms IS NOT NULL
      THEN CONCAT(
        FLOOR(qr.q3_time_ms / 60000)::TEXT, ':',
        LPAD(FLOOR((qr.q3_time_ms % 60000) / 1000)::TEXT, 2, '0'), '.',
        LPAD((qr.q3_time_ms % 1000)::TEXT, 3, '0')
      )
      ELSE NULL
    END AS q3_time,
    -- Format overall best time (for pre-2006 single-session qualifying)
    CASE WHEN qr.best_time_ms IS NOT NULL
      THEN CONCAT(
        FLOOR(qr.best_time_ms / 60000)::TEXT, ':',
        LPAD(FLOOR((qr.best_time_ms % 60000) / 1000)::TEXT, 2, '0'), '.',
        LPAD((qr.best_time_ms % 1000)::TEXT, 3, '0')
      )
      ELSE NULL
    END AS best_time,
    -- Best time in ms for gap calculation (Q3 > Q2 > Q1 > overall best)
    COALESCE(qr.q3_time_ms, qr.q2_time_ms, qr.q1_time_ms, qr.best_time_ms) AS best_time_ms,
    qr.is_dns
  FROM qualifying_results qr
  LEFT JOIN driver d ON d.id = REPLACE(qr.driver_id, '_', '-')
  LEFT JOIN constructor con ON con.id = REPLACE(qr.team_id, '_', '-')
  WHERE qr.season = $1
    AND qr.track_id = $2
    AND qr.session_type = 'RACE_QUALIFYING'
),
p1_time AS (
  SELECT best_time_ms FROM qualifying_data WHERE position = 1 LIMIT 1
)
SELECT
  qd.season,
  qd.round,
  qd.track_id,
  qd.position,
  qd.driver_id,
  qd.driver_name,
  qd.constructor_name,
  qd.q1_time,
  qd.q2_time,
  qd.q3_time,
  qd.best_time,
  -- P1 shows best time, P2+ show gap from P1
  CASE
    WHEN qd.is_dns THEN 'DNS'
    WHEN qd.position = 1 THEN COALESCE(qd.q3_time, qd.q2_time, qd.q1_time, qd.best_time)
    WHEN qd.best_time_ms IS NOT NULL AND p1.best_time_ms IS NOT NULL
      THEN CONCAT('+', ROUND((qd.best_time_ms - p1.best_time_ms)::NUMERIC / 1000, 3)::TEXT)
    ELSE 'N/A'
  END AS qualifying_time
FROM qualifying_data qd
CROSS JOIN p1_time p1
ORDER BY qd.position ASC;
