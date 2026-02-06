-- Season driver vs driver comparison with session-median percent normalization
-- Parameters: $1=driver_a_id, $2=driver_b_id, $3=season
--
-- METHODOLOGY:
-- 1. For each race, compute session median lap time (P50 of all valid laps)
-- 2. Normalize each driver's laps: (lap_time - session_median) / session_median * 100
-- 3. Per race: take median of normalized values for each driver
-- 4. Season aggregate: mean of per-race normalized values (equal weight per race)
--
-- Sign convention: negative = faster than field median, positive = slower
-- Units: percent

WITH valid_laps AS (
  -- Filter to valid race laps only
  SELECT
    season,
    round,
    track_id,
    driver_id,
    lap_time_seconds
  FROM laps_normalized
  WHERE season = $3
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
),
session_medians AS (
  -- Compute median lap time per race (session reference pace)
  SELECT
    season,
    round,
    track_id,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY lap_time_seconds) AS session_median
  FROM valid_laps
  GROUP BY season, round, track_id
  HAVING COUNT(*) >= 20  -- minimum laps for reliable session median
),
driver_normalized_laps AS (
  -- Normalize each lap as percent of session median
  SELECT
    vl.season,
    vl.round,
    vl.track_id,
    vl.driver_id,
    vl.lap_time_seconds,
    sm.session_median,
    -- normalized_percent: positive = slower, negative = faster
    ((vl.lap_time_seconds - sm.session_median) / sm.session_median) * 100 AS normalized_percent
  FROM valid_laps vl
  JOIN session_medians sm
    ON sm.season = vl.season
   AND sm.round = vl.round
   AND sm.track_id = vl.track_id
),
driver_race_medians AS (
  -- Per driver, per race: median of normalized percentages
  SELECT
    season,
    round,
    track_id,
    driver_id,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY normalized_percent) AS race_normalized_median,
    COUNT(*) AS race_laps
  FROM driver_normalized_laps
  GROUP BY season, round, track_id, driver_id
  HAVING COUNT(*) >= 5  -- minimum laps per race for reliable median
),
driver_a_races AS (
  SELECT
    season,
    round,
    track_id,
    race_normalized_median,
    race_laps
  FROM driver_race_medians
  WHERE driver_id = $1
),
driver_b_races AS (
  SELECT
    season,
    round,
    track_id,
    race_normalized_median,
    race_laps
  FROM driver_race_medians
  WHERE driver_id = $2
),
shared_races AS (
  -- Only include races where both drivers have data
  SELECT
    a.season,
    a.round,
    a.track_id,
    a.race_normalized_median AS driver_a_normalized,
    b.race_normalized_median AS driver_b_normalized,
    a.race_laps AS driver_a_race_laps,
    b.race_laps AS driver_b_race_laps
  FROM driver_a_races a
  JOIN driver_b_races b
    ON b.season = a.season
   AND b.round = a.round
   AND b.track_id = a.track_id
),
driver_aggregates AS (
  -- Season aggregate: mean of per-race values (equal weight per race)
  SELECT
    $1::text AS driver_a_id,
    $2::text AS driver_b_id,
    AVG(driver_a_normalized) AS driver_a_value,
    AVG(driver_b_normalized) AS driver_b_value,
    SUM(driver_a_race_laps)::int AS driver_a_laps,
    SUM(driver_b_race_laps)::int AS driver_b_laps,
    COUNT(*) AS shared_races
  FROM shared_races
)
SELECT
  driver_a_id,
  driver_b_id,
  driver_a_value,
  driver_b_value,
  (driver_a_value - driver_b_value) AS difference_percent,
  driver_a_laps,
  driver_b_laps,
  shared_races,
  CASE
    WHEN shared_races >= 8 THEN 'valid'
    WHEN shared_races >= 4 THEN 'low_coverage'
    ELSE 'insufficient'
  END AS coverage_status
FROM driver_aggregates
WHERE shared_races >= 1;
