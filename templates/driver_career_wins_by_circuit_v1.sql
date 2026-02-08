-- ============================================================================
-- DRIVER CAREER WINS BY CIRCUIT
-- ============================================================================
-- Template: driver_career_wins_by_circuit_v1.sql
-- Parameters:
--   $1 = driver_id (string) - F1DB driver.id
--
-- Returns all circuits where the driver has won, ranked by win count.
-- Includes total wins and last win year for each circuit.
--
-- USE CASE:
--   - "Hamilton wins by circuit"
--   - "Where has Verstappen won?"
--   - "Schumacher circuit victories"
--
-- METHODOLOGY:
--   - Queries race_data for RACE_RESULT where position_number = 1
--   - Groups by circuit to count wins per track
--   - Orders by win count descending, then by last win year descending
-- ============================================================================

WITH driver_wins AS (
  SELECT
    c.id AS circuit_id,
    c.name AS circuit_name,
    c.full_name AS circuit_full_name,
    gp.id AS grand_prix_id,
    gp.name AS grand_prix_name,
    r.year AS win_year
  FROM race_data rd
  JOIN race r ON rd.race_id = r.id
  JOIN circuit c ON r.circuit_id = c.id
  JOIN grand_prix gp ON r.grand_prix_id = gp.id
  WHERE rd.driver_id = $1
    AND rd.type IN ('RACE_RESULT', 'race')
    AND rd.position_number = 1
),

wins_by_circuit AS (
  SELECT
    circuit_id,
    circuit_name,
    circuit_full_name,
    grand_prix_id,
    grand_prix_name,
    COUNT(*) AS wins,
    MAX(win_year) AS last_win_year
  FROM driver_wins
  GROUP BY circuit_id, circuit_name, circuit_full_name, grand_prix_id, grand_prix_name
),

total_wins AS (
  SELECT COUNT(*) AS total FROM driver_wins
)

SELECT
  $1::text AS driver_id,
  (SELECT total FROM total_wins)::integer AS total_wins,
  wbc.circuit_id,
  wbc.circuit_name,
  wbc.circuit_full_name,
  wbc.grand_prix_id,
  wbc.grand_prix_name,
  wbc.wins::integer,
  wbc.last_win_year::integer
FROM wins_by_circuit wbc
ORDER BY wbc.wins DESC, wbc.last_win_year DESC;
