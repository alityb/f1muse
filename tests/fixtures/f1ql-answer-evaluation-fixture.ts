import { Pool } from 'pg';

export async function seedAnswerEvaluationFixture(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'red-bull', 'red-bull', 'max-verstappen'),
    (2025, 'mclaren', 'mclaren', 'lando-norris'),
    (2025, 'mclaren', 'mclaren', 'oscar-piastri'),
    (2025, 'sample', 'sample', 'sample-driver')`);
  await pool.query(`INSERT INTO season_driver_standing (year, position_display_order, position_number, position_text, driver_id, points) VALUES
    (2025, 1, 1, '1', 'lando_norris', 300),
    (2025, 2, 2, '2', 'oscar_piastri', 300),
    (2025, 3, 3, '3', 'max_verstappen', 25)`);
  await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('australian_grand_prix', 'Australian Grand Prix', 'Formula 1 Australian Grand Prix', 'Australian GP', 'AUS')`);
  await pool.query(`INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES
    (1, 2025, 1, 'albert-park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2025-03-16')`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, race_points, race_reason_retired) VALUES
    (1, 'RACE_RESULT', 'max_verstappen', 'red-bull', 1, 25, NULL),
    (1, 'RACE_RESULT', 'sample_driver', 'sample', NULL, 0, 'Engine')`);
  await pool.query(`INSERT INTO qualifying_results
    (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, is_dnf, is_dns) VALUES
    (2025, 1, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', false, false),
    (2025, 1, 'lando_norris', 'mclaren', NULL, NULL, NULL, false, true)`);
}
