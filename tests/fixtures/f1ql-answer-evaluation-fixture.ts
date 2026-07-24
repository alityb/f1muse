import { Pool } from 'pg';

export async function seedAnswerEvaluationFixture(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS driver_aliases (driver_id text, alias text, is_primary boolean)');
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES
    ('max_verstappen', 'Max Verstappen', 'Max Verstappen', 'Max', 'Verstappen', 'VER'),
    ('lando_norris', 'Lando Norris', 'Lando Norris', 'Lando', 'Norris', 'NOR'),
    ('oscar_piastri', 'Oscar Piastri', 'Oscar Piastri', 'Oscar', 'Piastri', 'PIA'),
    ('sample_driver', 'Sample Driver', 'Sample Driver', 'Sample', 'Driver', 'SAM'),
    ('alex_one', 'Alex One', 'Alex Smith', 'Alex', 'Smith', 'AO1'),
    ('alex_two', 'Alex Two', 'Alex Smith', 'Alex', 'Smith', 'AT2')`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id) VALUES
    (2025, 'red-bull', 'red-bull', 'max-verstappen'),
    (2025, 'mclaren', 'mclaren', 'lando-norris'),
    (2025, 'mclaren', 'mclaren', 'oscar-piastri'),
    (2025, 'sample', 'sample', 'sample-driver')`);
  await pool.query(`INSERT INTO season_driver_standing (year, position_display_order, position_number, position_text, driver_id, points) VALUES
    (2025, 1, 1, '1', 'oscar_piastri', 300),
    (2025, 2, 2, '2', 'lando_norris', 300),
    (2025, 3, 3, '3', 'max_verstappen', 25)`);
  await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('australian_grand_prix', 'Australian Grand Prix', 'Formula 1 Australian Grand Prix', 'Australian GP', 'AUS'),
    ('ambiguous_grand_prix', 'Ambiguous Grand Prix', 'Formula 1 Ambiguous Grand Prix', 'Ambiguous GP', 'AMB')`);
  await pool.query(`INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES
    (1, 2025, 1, 'albert-park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2025-03-16'),
    (8, 2025, 8, 'ambiguous-one', 'ambiguous_grand_prix', 'Formula 1 Ambiguous Grand Prix', '2025-06-01'),
    (9, 2025, 9, 'ambiguous-two', 'ambiguous_grand_prix', 'Formula 1 Ambiguous Grand Prix', '2025-06-08')`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, race_points, race_reason_retired) VALUES
    (1, 'RACE_RESULT', 'max_verstappen', 'red-bull', 1, 25, NULL),
    (1, 'RACE_RESULT', 'sample_driver', 'sample', NULL, 0, 'Engine')`);
  await pool.query(`INSERT INTO qualifying_results
    (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, is_dnf, is_dns) VALUES
    (2025, 1, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', false, false),
    (2025, 1, 'lando_norris', 'mclaren', NULL, NULL, NULL, false, true)`);
}
