-- PART 5: Driver multi-comparison (2-6 drivers)
-- Parameters: $1=season, $2=metric, $3=driver_ids (array)
--
-- Returns: Comparison of 2-6 drivers ranked by the specified metric.
-- All drivers must have data for the specified season.
--
-- Output fields per driver:
--   - driver_id: F1DB driver.id
--   - rank: Position in the comparison (1=best)
--   - metric_value: Value of the requested metric
--   - laps_considered: Number of laps used for calculation
--
-- Supported metrics:
--   - avg_true_pace: Average race lap time (lower=better)
--   - qualifying_pace: Average qualifying lap time (lower=better)
--   - consistency: Standard deviation of lap times (lower=more consistent)

WITH driver_list AS (
  SELECT UNNEST($3::TEXT[]) AS driver_id
),

-- Race pace per driver
-- Note: session_type may be NULL, so we filter by valid race-like laps only
-- NOTE: is_pit_lap filter removed due to data quality issue (all laps marked as pit laps)
race_pace AS (
  SELECT
    ln.driver_id,
    AVG(ln.lap_time_seconds) AS avg_race_pace,
    STDDEV_SAMP(ln.lap_time_seconds) AS race_pace_stddev,
    COUNT(*) AS race_laps
  FROM laps_normalized ln
  INNER JOIN driver_list dl ON dl.driver_id = ln.driver_id
  WHERE ln.season = $1
    AND ln.is_valid_lap = true
    AND ln.lap_time_seconds IS NOT NULL
  GROUP BY ln.driver_id
),

-- Qualifying pace per driver
-- Note: Use fastest lap as qualifying proxy since session_type may be NULL
-- NOTE: is_pit_lap filter removed due to data quality issue
quali_pace AS (
  SELECT
    ln.driver_id,
    MIN(ln.lap_time_seconds) AS avg_quali_pace,  -- Use fastest lap as qualifying proxy
    COUNT(*) AS quali_laps
  FROM laps_normalized ln
  INNER JOIN driver_list dl ON dl.driver_id = ln.driver_id
  WHERE ln.season = $1
    AND ln.is_valid_lap = true
    AND ln.lap_time_seconds IS NOT NULL
  GROUP BY ln.driver_id
),

-- Combined metrics
driver_metrics AS (
  SELECT
    dl.driver_id,
    COALESCE(rp.avg_race_pace, qp.avg_quali_pace) AS avg_true_pace,
    qp.avg_quali_pace AS qualifying_pace,
    rp.race_pace_stddev AS consistency,
    COALESCE(rp.race_laps, 0) AS race_laps,
    COALESCE(qp.quali_laps, 0) AS quali_laps
  FROM driver_list dl
  LEFT JOIN race_pace rp ON rp.driver_id = dl.driver_id
  LEFT JOIN quali_pace qp ON qp.driver_id = dl.driver_id
),

-- Apply ranking based on metric
ranked_drivers AS (
  SELECT
    dm.driver_id,
    CASE $2
      WHEN 'avg_true_pace' THEN dm.avg_true_pace
      WHEN 'qualifying_pace' THEN dm.qualifying_pace
      WHEN 'consistency' THEN dm.consistency
      ELSE dm.avg_true_pace
    END AS metric_value,
    CASE $2
      WHEN 'avg_true_pace' THEN dm.race_laps
      WHEN 'qualifying_pace' THEN dm.quali_laps
      WHEN 'consistency' THEN dm.race_laps
      ELSE dm.race_laps
    END AS laps_considered,
    RANK() OVER (ORDER BY
      CASE $2
        WHEN 'avg_true_pace' THEN dm.avg_true_pace
        WHEN 'qualifying_pace' THEN dm.qualifying_pace
        WHEN 'consistency' THEN dm.consistency
        ELSE dm.avg_true_pace
      END ASC NULLS LAST
    ) AS rank
  FROM driver_metrics dm
  WHERE (CASE $2
    WHEN 'avg_true_pace' THEN dm.avg_true_pace
    WHEN 'qualifying_pace' THEN dm.qualifying_pace
    WHEN 'consistency' THEN dm.consistency
    ELSE dm.avg_true_pace
  END) IS NOT NULL
)

SELECT
  rd.driver_id,
  rd.rank::INT,
  rd.metric_value::NUMERIC(10,3),
  rd.laps_considered::INT,
  $1::INT AS season,
  $2::TEXT AS metric,
  (SELECT COUNT(*) FROM driver_list)::INT AS total_drivers,
  (SELECT COUNT(*) FROM ranked_drivers)::INT AS ranked_drivers
FROM ranked_drivers rd
ORDER BY rd.rank ASC;
