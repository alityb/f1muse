-- Season driver summary (wins, podiums, DNFs, race count, avg race pace)
-- Parameters: $1=driver_id, $2=season

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
pace AS (
  SELECT
    AVG(lap_time_seconds)::numeric AS avg_race_pace,
    COUNT(*) AS laps_considered
  FROM laps_normalized
  WHERE season = $2
    AND driver_id = $1
    AND is_valid_lap = true
    AND lap_time_seconds IS NOT NULL
)
SELECT
  $1::text AS driver_id,
  $2::int AS season,
  race_counts.wins,
  race_counts.podiums,
  race_counts.dnfs,
  race_counts.race_count,
  pace.avg_race_pace,
  pace.laps_considered
FROM race_counts, pace;
