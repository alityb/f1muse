-- Data Completeness Audit for Normalized Pace Data
-- Checks 2024 and 2025 seasons for:
--   1. Session median exists (≥20 valid laps per race)
--   2. Normalized pace data exists for classified drivers (≥5 valid laps)
--
-- IMPORTANT: This uses season+round joins (NOT track_id) because:
--   - laps_normalized.track_id uses grand_prix names (e.g., "bahrain_grand_prix")
--   - race.circuit_id uses circuit IDs (e.g., "bahrain")
--   - Season + round is the reliable unique identifier

WITH race_sessions AS (
    SELECT
        r.year AS season,
        r.round,
        r.circuit_id AS track_id,
        c.name AS track_name
    FROM race r
    JOIN circuit c ON r.circuit_id = c.id
    WHERE r.year IN (2024, 2025)
    ORDER BY r.year, r.round
),

session_laps AS (
    -- Count valid laps per race (join by season+round only)
    SELECT
        season,
        round,
        COUNT(*) AS valid_lap_count,
        COUNT(DISTINCT driver_id) AS unique_drivers
    FROM laps_normalized
    WHERE season IN (2024, 2025)
      AND is_valid_lap = true
      AND lap_time_seconds IS NOT NULL
    GROUP BY season, round
),

classified_drivers AS (
    SELECT
        r.year AS season,
        r.round,
        COUNT(DISTINCT rd.driver_id) AS classified_count
    FROM race r
    JOIN race_data rd ON rd.race_id = r.id
    WHERE r.year IN (2024, 2025)
      AND rd.type = 'RACE_RESULT'
      AND rd.position_number IS NOT NULL
      AND rd.position_number <= 20
    GROUP BY r.year, r.round
),

driver_lap_counts AS (
    SELECT
        season,
        round,
        driver_id,
        COUNT(*) AS lap_count
    FROM laps_normalized
    WHERE season IN (2024, 2025)
      AND is_valid_lap = true
      AND lap_time_seconds IS NOT NULL
    GROUP BY season, round, driver_id
),

drivers_meeting_threshold AS (
    -- Count drivers with ≥5 valid laps (threshold for normalized pace)
    SELECT
        season,
        round,
        COUNT(DISTINCT driver_id) AS drivers_with_sufficient_data
    FROM driver_lap_counts
    WHERE lap_count >= 5
    GROUP BY season, round
)

SELECT
    rs.season,
    rs.round,
    rs.track_name,
    COALESCE(sl.valid_lap_count, 0) AS session_laps,
    CASE WHEN COALESCE(sl.valid_lap_count, 0) >= 20 THEN 'YES' ELSE 'NO' END AS session_median,
    COALESCE(cd.classified_count, 0) AS classified_drivers,
    COALESCE(dmt.drivers_with_sufficient_data, 0) AS drivers_with_data,
    GREATEST(0, COALESCE(cd.classified_count, 0) - COALESCE(dmt.drivers_with_sufficient_data, 0)) AS missing_normalized,
    CASE
        WHEN COALESCE(sl.valid_lap_count, 0) < 20 THEN 'MISSING_MEDIAN'
        WHEN COALESCE(dmt.drivers_with_sufficient_data, 0) >= COALESCE(cd.classified_count, 0) THEN 'COMPLETE'
        WHEN COALESCE(dmt.drivers_with_sufficient_data, 0) >= COALESCE(cd.classified_count, 0) * 0.8 THEN 'MOSTLY_COMPLETE'
        ELSE 'PARTIAL'
    END AS status
FROM race_sessions rs
LEFT JOIN session_laps sl ON sl.season = rs.season AND sl.round = rs.round
LEFT JOIN classified_drivers cd ON cd.season = rs.season AND cd.round = rs.round
LEFT JOIN drivers_meeting_threshold dmt ON dmt.season = rs.season AND dmt.round = rs.round
ORDER BY rs.season, rs.round;
