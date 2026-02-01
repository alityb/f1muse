-- PART 4: Driver performance vector (cross-metric profile)
-- Parameters: $1=driver_id, $2=season
--
-- Returns: Multi-dimensional performance profile for a single driver
-- Including percentile rankings, consistency, and contextual performance.
--
-- Output fields:
--   - qualifying_percentile: Percentile rank for avg qualifying pace (0-100, 100=fastest)
--   - race_pace_percentile: Percentile rank for avg race pace (0-100, 100=fastest)
--   - consistency_score: 100 - normalized(std_dev of lap times) (100=most consistent)
--   - street_delta: Gap to grid median on street circuits (negative=faster)
--   - wet_delta: Gap to grid median in wet races (negative=faster)
--
-- Note: Percentiles are computed against all drivers with sufficient data in that season.

WITH
-- Grid qualifying pace (avg qualifying lap time per driver)
-- Note: session_type may be NULL, so we also check for short stints (qualifying-like)
-- For now, we use fastest laps as proxy for qualifying pace
grid_quali AS (
  SELECT
    driver_id,
    MIN(lap_time_seconds) AS avg_quali_pace,  -- Use fastest lap as qualifying proxy
    COUNT(*) AS quali_laps
  FROM laps_normalized
  WHERE season = $2
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue (all laps marked as pit laps)
  GROUP BY driver_id
  HAVING COUNT(*) >= 5  -- Minimum 5 laps for fastest lap calculation
),

-- Grid race pace (avg race lap time per driver)
-- Note: session_type may be NULL, so we filter by valid race-like laps
grid_race AS (
  SELECT
    driver_id,
    AVG(lap_time_seconds) AS avg_race_pace,
    STDDEV_SAMP(lap_time_seconds) AS race_pace_stddev,
    COUNT(*) AS race_laps
  FROM laps_normalized
  WHERE season = $2
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue
  GROUP BY driver_id
  HAVING COUNT(*) >= 20  -- Minimum 20 race laps
),

-- Street circuit performance
street_circuit_ids AS (
  -- Known street circuits
  SELECT UNNEST(ARRAY[
    'monaco', 'singapore', 'baku', 'jeddah', 'melbourne', 'las-vegas',
    'monaco-grand-prix', 'singapore-grand-prix', 'azerbaijan-grand-prix',
    'saudi-arabian-grand-prix', 'australian-grand-prix', 'las-vegas-grand-prix'
  ]) AS circuit_id
),
grid_street AS (
  SELECT
    ln.driver_id,
    AVG(ln.lap_time_seconds) AS avg_street_pace,
    COUNT(*) AS street_laps
  FROM laps_normalized ln
  WHERE ln.season = $2
    AND ln.is_valid_lap = true
    AND ln.lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue
    AND (ln.track_id IN (SELECT circuit_id FROM street_circuit_ids)
         OR ln.race_name ILIKE '%monaco%'
         OR ln.race_name ILIKE '%singapore%'
         OR ln.race_name ILIKE '%baku%'
         OR ln.race_name ILIKE '%jeddah%'
         OR ln.race_name ILIKE '%las vegas%')
  GROUP BY ln.driver_id
  HAVING COUNT(*) >= 10
),
street_grid_median AS (
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY avg_street_pace) AS median_pace
  FROM grid_street
),

-- Wet race performance (simplified: any race with at least some wet laps)
wet_race_ids AS (
  SELECT DISTINCT round
  FROM laps_normalized
  WHERE season = $2
    AND session_type = 'R'
    AND compound IN ('INTERMEDIATE', 'WET')
),
grid_wet AS (
  SELECT
    ln.driver_id,
    AVG(ln.lap_time_seconds) AS avg_wet_pace,
    COUNT(*) AS wet_laps
  FROM laps_normalized ln
  WHERE ln.season = $2
    AND ln.is_valid_lap = true
    AND ln.lap_time_seconds IS NOT NULL
    -- NOTE: is_pit_lap filter removed due to data quality issue
    AND ln.round IN (SELECT round FROM wet_race_ids)
  GROUP BY ln.driver_id
  HAVING COUNT(*) >= 5
),
wet_grid_median AS (
  SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY avg_wet_pace) AS median_pace
  FROM grid_wet
),

-- Compute percentile ranks (lower pace = better, so we invert)
quali_percentiles AS (
  SELECT
    driver_id,
    avg_quali_pace,
    100.0 - (PERCENT_RANK() OVER (ORDER BY avg_quali_pace ASC) * 100) AS percentile
  FROM grid_quali
),
race_percentiles AS (
  SELECT
    driver_id,
    avg_race_pace,
    race_pace_stddev,
    100.0 - (PERCENT_RANK() OVER (ORDER BY avg_race_pace ASC) * 100) AS percentile
  FROM grid_race
),

-- Consistency score: 100 - normalized stddev
-- Lower stddev = higher consistency
consistency_scores AS (
  SELECT
    driver_id,
    race_pace_stddev,
    CASE
      WHEN MAX(race_pace_stddev) OVER () - MIN(race_pace_stddev) OVER () = 0 THEN 100
      ELSE 100.0 - (
        (race_pace_stddev - MIN(race_pace_stddev) OVER ()) /
        NULLIF(MAX(race_pace_stddev) OVER () - MIN(race_pace_stddev) OVER (), 0) * 100
      )
    END AS consistency_score
  FROM grid_race
),

-- Target driver data
driver_quali AS (
  SELECT percentile FROM quali_percentiles WHERE driver_id = $1
),
driver_race AS (
  SELECT percentile FROM race_percentiles WHERE driver_id = $1
),
driver_consistency AS (
  SELECT consistency_score FROM consistency_scores WHERE driver_id = $1
),
driver_street AS (
  SELECT avg_street_pace FROM grid_street WHERE driver_id = $1
),
driver_wet AS (
  SELECT avg_wet_pace FROM grid_wet WHERE driver_id = $1
)

SELECT
  $1::TEXT AS driver_id,
  $2::INT AS season,
  COALESCE((SELECT percentile FROM driver_quali), NULL)::NUMERIC(5,2) AS qualifying_percentile,
  COALESCE((SELECT percentile FROM driver_race), NULL)::NUMERIC(5,2) AS race_pace_percentile,
  COALESCE((SELECT consistency_score FROM driver_consistency), NULL)::NUMERIC(5,2) AS consistency_score,
  CASE
    WHEN (SELECT avg_street_pace FROM driver_street) IS NOT NULL
         AND (SELECT median_pace FROM street_grid_median) IS NOT NULL
    THEN ((SELECT avg_street_pace FROM driver_street) - (SELECT median_pace FROM street_grid_median))::NUMERIC(6,3)
    ELSE NULL
  END AS street_delta,
  CASE
    WHEN (SELECT avg_wet_pace FROM driver_wet) IS NOT NULL
         AND (SELECT median_pace FROM wet_grid_median) IS NOT NULL
    THEN ((SELECT avg_wet_pace FROM driver_wet) - (SELECT median_pace FROM wet_grid_median))::NUMERIC(6,3)
    ELSE NULL
  END AS wet_delta,
  -- Sample sizes for confidence
  COALESCE((SELECT quali_laps FROM grid_quali WHERE driver_id = $1), 0)::INT AS qualifying_laps,
  COALESCE((SELECT race_laps FROM grid_race WHERE driver_id = $1), 0)::INT AS race_laps,
  COALESCE((SELECT street_laps FROM grid_street WHERE driver_id = $1), 0)::INT AS street_laps,
  COALESCE((SELECT wet_laps FROM grid_wet WHERE driver_id = $1), 0)::INT AS wet_laps;
