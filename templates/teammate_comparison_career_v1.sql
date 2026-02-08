-- ============================================================================
-- TEAMMATE COMPARISON CAREER (Multi-Season)
-- ============================================================================
-- Template: teammate_comparison_career_v1.sql
-- Parameters:
--   $1 = driver_a_id (string) - F1DB driver.id (preserves user query order)
--   $2 = driver_b_id (string) - F1DB driver.id
--
-- Returns per-season teammate comparison with aggregated statistics.
-- Auto-detects all seasons where both drivers were teammates.
--
-- USE CASE:
--   - "Hamilton vs Russell as teammates"
--   - "Norris vs Piastri all seasons"
--   - "Verstappen Ricciardo teammate history"
--
-- METHODOLOGY:
--   - Finds shared seasons using season_entrant_driver table
--   - Pulls pace gaps from teammate_gap_season_summary
--   - Aggregates across all shared seasons
--
-- NOTE: Driver order is normalized to lexicographic in teammate_gap_season_summary,
--       so we need to detect which driver is primary/secondary and adjust signs accordingly.
-- ============================================================================

WITH shared_seasons AS (
  -- Find all seasons where both drivers were teammates
  SELECT DISTINCT
    sed1.year AS season,
    CASE
      -- Normalize constructor names
      WHEN sed1.constructor_id ILIKE '%mclaren%' THEN 'mclaren'
      WHEN sed1.constructor_id ILIKE '%ferrari%' THEN 'ferrari'
      WHEN sed1.constructor_id ILIKE '%red%bull%' THEN 'red-bull'
      WHEN sed1.constructor_id ILIKE '%mercedes%' THEN 'mercedes'
      WHEN sed1.constructor_id ILIKE '%aston%martin%' THEN 'aston-martin'
      WHEN sed1.constructor_id ILIKE '%alpine%' THEN 'alpine'
      WHEN sed1.constructor_id ILIKE '%williams%' THEN 'williams'
      WHEN sed1.constructor_id ILIKE '%haas%' THEN 'haas'
      WHEN sed1.constructor_id ILIKE '%sauber%' OR sed1.constructor_id ILIKE '%kick%' OR sed1.constructor_id ILIKE '%stake%' THEN 'kick-sauber'
      WHEN sed1.constructor_id ILIKE '%rb%' OR sed1.constructor_id ILIKE '%racing%bulls%' OR sed1.constructor_id ILIKE '%visa%' THEN 'racing-bulls'
      ELSE sed1.constructor_id
    END AS team_id,
    sed1.constructor_id AS raw_team_id
  FROM season_entrant_driver sed1
  JOIN season_entrant_driver sed2
    ON sed1.year = sed2.year
    AND sed1.constructor_id = sed2.constructor_id
  WHERE sed1.driver_id = $1
    AND sed2.driver_id = $2
),

-- Get teammate gap data for each shared season
-- Need to handle lexicographic ordering
season_gaps AS (
  SELECT
    ss.season,
    ss.team_id,
    tgs.driver_primary_id,
    tgs.driver_secondary_id,
    -- Adjust gap sign based on query order vs storage order
    CASE
      WHEN tgs.driver_primary_id = $1 THEN tgs.driver_pair_gap_seconds
      ELSE -tgs.driver_pair_gap_seconds  -- Flip sign if order is reversed
    END AS gap_seconds,
    CASE
      WHEN tgs.driver_primary_id = $1 THEN tgs.driver_pair_gap_percent
      ELSE -tgs.driver_pair_gap_percent  -- Flip sign if order is reversed
    END AS gap_pct,
    tgs.shared_races,
    CASE
      WHEN tgs.driver_primary_id = $1 THEN tgs.faster_driver_primary_count
      ELSE tgs.shared_races - tgs.faster_driver_primary_count  -- Complement count
    END AS faster_primary_count,
    tgs.coverage_status
  FROM shared_seasons ss
  LEFT JOIN teammate_gap_season_summary tgs
    ON tgs.season = ss.season
    AND (
      (tgs.driver_primary_id = $1 AND tgs.driver_secondary_id = $2)
      OR (tgs.driver_primary_id = $2 AND tgs.driver_secondary_id = $1)
    )
    AND COALESCE(tgs.failure_reason, '') = ''
),

-- Aggregate stats across all seasons
aggregate_stats AS (
  SELECT
    SUM(COALESCE(shared_races, 0))::integer AS total_shared_races,
    SUM(COALESCE(faster_primary_count, 0))::integer AS total_faster_primary_count,
    AVG(gap_seconds) AS avg_gap_seconds,
    COUNT(DISTINCT season)::integer AS seasons_together
  FROM season_gaps
  WHERE shared_races > 0
)

SELECT
  $1::text AS driver_a_id,
  $2::text AS driver_b_id,
  sg.season,
  sg.team_id,
  sg.gap_seconds,
  sg.gap_pct,
  sg.shared_races,
  sg.faster_primary_count,
  sg.coverage_status,
  -- Aggregates (same for all rows)
  (SELECT total_shared_races FROM aggregate_stats) AS total_shared_races,
  (SELECT total_faster_primary_count FROM aggregate_stats) AS total_faster_primary_count,
  (SELECT avg_gap_seconds FROM aggregate_stats) AS avg_gap_seconds,
  (SELECT seasons_together FROM aggregate_stats) AS seasons_together,
  CASE
    WHEN (SELECT avg_gap_seconds FROM aggregate_stats) < -0.01 THEN 'primary'
    WHEN (SELECT avg_gap_seconds FROM aggregate_stats) > 0.01 THEN 'secondary'
    ELSE 'draw'
  END AS overall_winner
FROM season_gaps sg
WHERE sg.season IS NOT NULL
  AND COALESCE(sg.shared_races, 0) > 0  -- Exclude seasons with no shared race data
ORDER BY sg.season DESC;
