-- Season driver summary (wins, podiums, DNFs, race count, normalized avg race pace)
-- Parameters: $1=driver_id, $2=season
--
-- METHODOLOGY:
-- Race results (wins, podiums, DNFs) come from race_data table.
-- Pace is NORMALIZED using session-median percent:
--   1. For each race, compute session median lap time (P50 of all valid laps)
--   2. Normalize each driver lap: (lap_time - session_median) / session_median * 100
--   3. Season aggregate: mean of normalized values
--
-- Sign convention: negative = faster than field median, positive = slower
-- Units: percent

WITH driver_races AS (
  SELECT
    rd.race_id,
    rd.position_number,
    rd.race_reason_retired
  FROM race_data rd
  JOIN race r ON r.id = rd.race_id
  WHERE r.year = $2
    AND rd.driver_id = $1
    AND rd.type IN ('RACE_RESULT', 'race')
),
race_counts AS (
  SELECT
    COUNT(*) AS race_count,
    COUNT(*) FILTER (WHERE position_number = 1) AS wins,
    COUNT(*) FILTER (WHERE position_number IN (1, 2, 3)) AS podiums,
    COUNT(*) FILTER (
      WHERE race_reason_retired IS NOT NULL
        AND race_reason_retired <> ''
    ) AS dnfs
  FROM driver_races
),
-- Pole positions from qualifying_results table
pole_count AS (
  SELECT COUNT(*) AS poles
  FROM qualifying_results qr
  WHERE qr.season = $2
    AND (qr.driver_id = $1 OR qr.driver_id = REPLACE($1, '-', '_'))
    AND qr.qualifying_position = 1
    AND qr.session_type = 'RACE_QUALIFYING'
),
-- Compute session median per race (all drivers' valid laps)
session_medians AS (
  SELECT
    round,
    track_id,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS session_median
  FROM laps_normalized
  WHERE season = $2
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
  GROUP BY round, track_id
  HAVING COUNT(*) >= 20  -- minimum laps for reliable median
),
-- Normalize driver's laps against session median
driver_normalized_laps AS (
  SELECT
    ln.round,
    ln.track_id,
    ((ln.lap_time_seconds - sm.session_median) / sm.session_median) * 100 AS gap_pct
  FROM laps_normalized ln
  JOIN session_medians sm
    ON sm.round = ln.round
    AND sm.track_id = ln.track_id
  WHERE ln.season = $2
    AND ln.driver_id = $1
    AND ln.is_valid_lap = true
    AND ln.lap_time_seconds IS NOT NULL
),
-- Aggregate: mean of normalized values (equal weight per lap)
pace AS (
  SELECT
    AVG(gap_pct)::numeric AS avg_race_pace_pct,
    COUNT(*) AS laps_considered,
    COUNT(DISTINCT round) AS races_with_pace_data
  FROM driver_normalized_laps
)
SELECT
  $1::text AS driver_id,
  $2::int AS season,
  race_counts.wins,
  race_counts.podiums,
  race_counts.dnfs,
  race_counts.race_count,
  pole_count.poles,
  pace.avg_race_pace_pct,
  pace.laps_considered,
  pace.races_with_pace_data,
  CASE
    WHEN pace.races_with_pace_data >= 15 THEN 'valid'
    WHEN pace.races_with_pace_data >= 8 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status
FROM race_counts, pole_count, pace;
