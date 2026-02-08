-- ============================================================================
-- TEAMMATE COMPARISON CAREER (Position-Based, Full History)
-- ============================================================================
-- Template: teammate_comparison_career_results_v1.sql
-- Parameters:
--   $1 = driver_a_id (string) - F1DB driver.id
--   $2 = driver_b_id (string) - F1DB driver.id
--
-- Returns career teammate comparison based on race finishing positions.
-- Uses F1DB race_data for full historical coverage (1950-present).
--
-- USE CASE:
--   - "Hamilton vs Button as teammates" (2010-2012)
--   - "Senna vs Prost as teammates" (1988-1989)
--   - "Schumacher vs Barrichello teammate history"
--
-- METHODOLOGY:
--   - Finds shared seasons using season_entrant_driver table
--   - Compares finishing positions from race_data
--   - Counts wins, podiums, DNFs for each driver
--   - Head-to-head: who finished ahead when both classified
--
-- NOTE: This is POSITION-based (who finished ahead), not PACE-based.
--       For pace analysis (lap time gaps), use teammate_comparison_career_v1.sql
-- ============================================================================

WITH shared_seasons AS (
  -- Find all seasons where both drivers were teammates
  SELECT DISTINCT
    sed1.year AS season,
    sed1.constructor_id,
    c.name AS team_name
  FROM season_entrant_driver sed1
  JOIN season_entrant_driver sed2
    ON sed1.year = sed2.year
    AND sed1.constructor_id = sed2.constructor_id
  JOIN constructor c ON sed1.constructor_id = c.id
  WHERE sed1.driver_id = $1
    AND sed2.driver_id = $2
),

-- Get race results for both drivers in shared seasons
race_results AS (
  SELECT
    ss.season,
    ss.team_name,
    r.id AS race_id,
    r.round,
    r.official_name AS race_name,
    rd.driver_id,
    rd.position_number,
    rd.position_text,
    CASE WHEN rd.position_number = 1 THEN 1 ELSE 0 END AS is_win,
    CASE WHEN rd.position_number <= 3 AND rd.position_number IS NOT NULL THEN 1 ELSE 0 END AS is_podium,
    CASE WHEN rd.position_text IN ('DNF', 'DSQ', 'DNS', 'NC', 'Ret', 'EX') OR rd.position_number IS NULL THEN 1 ELSE 0 END AS is_dnf,
    COALESCE(rd.race_points, 0) AS points
  FROM shared_seasons ss
  JOIN race r ON r.year = ss.season
  JOIN race_data rd ON rd.race_id = r.id AND rd.constructor_id = ss.constructor_id
  WHERE rd.driver_id IN ($1, $2)
    AND rd.type IN ('RACE_RESULT', 'race')
),

-- Head to head: races where both drivers finished (classified)
head_to_head AS (
  SELECT
    rr1.season,
    rr1.race_id,
    rr1.race_name,
    CASE
      WHEN rr1.position_number < rr2.position_number THEN $1
      WHEN rr2.position_number < rr1.position_number THEN $2
      ELSE 'tie'
    END AS winner
  FROM race_results rr1
  JOIN race_results rr2
    ON rr1.race_id = rr2.race_id
    AND rr1.driver_id = $1
    AND rr2.driver_id = $2
  WHERE rr1.position_number IS NOT NULL
    AND rr2.position_number IS NOT NULL
    AND rr1.is_dnf = 0
    AND rr2.is_dnf = 0
),

-- Aggregate by season for driver A
season_stats_a AS (
  SELECT
    season,
    team_name,
    COUNT(DISTINCT race_id) AS races,
    SUM(is_win) AS wins,
    SUM(is_podium) AS podiums,
    SUM(is_dnf) AS dnfs,
    SUM(points) AS points
  FROM race_results
  WHERE driver_id = $1
  GROUP BY season, team_name
),

-- Aggregate by season for driver B
season_stats_b AS (
  SELECT
    season,
    team_name,
    COUNT(DISTINCT race_id) AS races,
    SUM(is_win) AS wins,
    SUM(is_podium) AS podiums,
    SUM(is_dnf) AS dnfs,
    SUM(points) AS points
  FROM race_results
  WHERE driver_id = $2
  GROUP BY season, team_name
),

-- H2H by season
season_h2h AS (
  SELECT
    season,
    COUNT(*) FILTER (WHERE winner = $1) AS a_wins,
    COUNT(*) FILTER (WHERE winner = $2) AS b_wins,
    COUNT(*) FILTER (WHERE winner = 'tie') AS ties
  FROM head_to_head
  GROUP BY season
),

-- Career totals
career_totals AS (
  SELECT
    (SELECT COALESCE(SUM(wins), 0) FROM season_stats_a) AS a_total_wins,
    (SELECT COALESCE(SUM(podiums), 0) FROM season_stats_a) AS a_total_podiums,
    (SELECT COALESCE(SUM(dnfs), 0) FROM season_stats_a) AS a_total_dnfs,
    (SELECT COALESCE(SUM(points), 0) FROM season_stats_a) AS a_total_points,
    (SELECT COALESCE(SUM(wins), 0) FROM season_stats_b) AS b_total_wins,
    (SELECT COALESCE(SUM(podiums), 0) FROM season_stats_b) AS b_total_podiums,
    (SELECT COALESCE(SUM(dnfs), 0) FROM season_stats_b) AS b_total_dnfs,
    (SELECT COALESCE(SUM(points), 0) FROM season_stats_b) AS b_total_points,
    (SELECT COUNT(*) FILTER (WHERE winner = $1) FROM head_to_head) AS a_h2h_wins,
    (SELECT COUNT(*) FILTER (WHERE winner = $2) FROM head_to_head) AS b_h2h_wins,
    (SELECT COUNT(*) FILTER (WHERE winner = 'tie') FROM head_to_head) AS h2h_ties,
    (SELECT COUNT(*) FROM head_to_head) AS total_h2h_races,
    (SELECT COUNT(DISTINCT season) FROM shared_seasons) AS seasons_together
)

SELECT
  $1::text AS driver_a_id,
  $2::text AS driver_b_id,
  sa.season,
  sa.team_name,
  -- Driver A season stats
  COALESCE(sa.races, 0)::integer AS a_races,
  COALESCE(sa.wins, 0)::integer AS a_wins,
  COALESCE(sa.podiums, 0)::integer AS a_podiums,
  COALESCE(sa.dnfs, 0)::integer AS a_dnfs,
  COALESCE(sa.points, 0)::numeric AS a_points,
  -- Driver B season stats
  COALESCE(sb.races, 0)::integer AS b_races,
  COALESCE(sb.wins, 0)::integer AS b_wins,
  COALESCE(sb.podiums, 0)::integer AS b_podiums,
  COALESCE(sb.dnfs, 0)::integer AS b_dnfs,
  COALESCE(sb.points, 0)::numeric AS b_points,
  -- Season H2H
  COALESCE(sh.a_wins, 0)::integer AS season_h2h_a,
  COALESCE(sh.b_wins, 0)::integer AS season_h2h_b,
  COALESCE(sh.ties, 0)::integer AS season_h2h_ties,
  -- Career totals (same for all rows)
  (SELECT a_total_wins FROM career_totals)::integer AS career_a_wins,
  (SELECT a_total_podiums FROM career_totals)::integer AS career_a_podiums,
  (SELECT a_total_dnfs FROM career_totals)::integer AS career_a_dnfs,
  (SELECT a_total_points FROM career_totals)::numeric AS career_a_points,
  (SELECT b_total_wins FROM career_totals)::integer AS career_b_wins,
  (SELECT b_total_podiums FROM career_totals)::integer AS career_b_podiums,
  (SELECT b_total_dnfs FROM career_totals)::integer AS career_b_dnfs,
  (SELECT b_total_points FROM career_totals)::numeric AS career_b_points,
  (SELECT a_h2h_wins FROM career_totals)::integer AS career_h2h_a,
  (SELECT b_h2h_wins FROM career_totals)::integer AS career_h2h_b,
  (SELECT h2h_ties FROM career_totals)::integer AS career_h2h_ties,
  (SELECT total_h2h_races FROM career_totals)::integer AS total_classified_races,
  (SELECT seasons_together FROM career_totals)::integer AS seasons_together,
  -- Overall winner
  CASE
    WHEN (SELECT a_h2h_wins FROM career_totals) > (SELECT b_h2h_wins FROM career_totals) THEN 'driver_a'
    WHEN (SELECT b_h2h_wins FROM career_totals) > (SELECT a_h2h_wins FROM career_totals) THEN 'driver_b'
    ELSE 'tie'
  END AS overall_h2h_winner
FROM season_stats_a sa
LEFT JOIN season_stats_b sb ON sa.season = sb.season
LEFT JOIN season_h2h sh ON sa.season = sh.season
ORDER BY sa.season DESC;
