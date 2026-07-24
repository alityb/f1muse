import { Pool } from 'pg';

export async function seedAnswerEvaluationFixture(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS driver_aliases (driver_id text, alias text, is_primary boolean)');
  await pool.query(`INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation) VALUES
    ('max_verstappen', 'Max Verstappen', 'Max Verstappen', 'Max', 'Verstappen', 'VER'),
    ('lando_norris', 'Lando Norris', 'Lando Norris', 'Lando', 'Norris', 'NOR'),
    ('oscar_piastri', 'Oscar Piastri', 'Oscar Piastri', 'Oscar', 'Piastri', 'PIA'),
    ('charles_leclerc', 'Charles Leclerc', 'Charles Leclerc', 'Charles', 'Leclerc', 'LEC'),
    ('lewis_hamilton', 'Lewis Hamilton', 'Lewis Hamilton', 'Lewis', 'Hamilton', 'HAM'),
    ('sample_driver', 'Sample Driver', 'Sample Driver', 'Sample', 'Driver', 'SAM'),
    ('alex_one', 'Alex One', 'Alex Smith', 'Alex', 'Smith', 'AO1'),
    ('alex_two', 'Alex Two', 'Alex Smith', 'Alex', 'Smith', 'AT2')`);
  await pool.query(`INSERT INTO driver_aliases (driver_id, alias, is_primary) VALUES
    ('max_verstappen', 'Mad Max', false),
    ('charles_leclerc', 'Leclerc', false),
    ('lando_norris', 'NOR', false)`);
  await pool.query(`INSERT INTO season_entrant_driver (year, entrant_id, constructor_id, driver_id, test_driver) VALUES
    (2025, 'red-bull', 'red-bull', 'max_verstappen', false),
    (2025, 'mclaren', 'mclaren', 'lando_norris', false),
    (2025, 'mclaren', 'mclaren', 'oscar_piastri', false),
    (2025, 'sample', 'sample', 'sample_driver', false),
    (2025, 'ferrari', 'ferrari', 'charles_leclerc', false),
    (2025, 'ambiguous-one', 'ambiguous-one', 'alex_one', false),
    (2025, 'ambiguous-two', 'ambiguous-two', 'alex_two', false),
    (2024, 'ferrari', 'ferrari', 'charles_leclerc', false),
    (2024, 'mercedes', 'mercedes', 'lewis_hamilton', false)`);
  await pool.query(`INSERT INTO season_driver_standing (year, position_display_order, position_number, position_text, driver_id, points) VALUES
    (2025, 1, 1, '1', 'oscar_piastri', 300),
    (2025, 2, 2, '2', 'lando_norris', 300),
    (2025, 3, 3, '3', 'max_verstappen', 25),
    (2024, 1, 1, '1', 'lewis_hamilton', 389),
    (2024, 2, 2, '2', 'charles_leclerc', 356)`);
  await pool.query(`INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
    ('australian_grand_prix', 'Australian Grand Prix', 'Formula 1 Australian Grand Prix', 'Australian GP', 'AUS'),
    ('monaco_grand_prix', 'Monaco Grand Prix', 'Formula 1 Monaco Grand Prix', 'Monaco GP', 'MON'),
    ('belgian_grand_prix', 'Belgian Grand Prix', 'Formula 1 Belgian Grand Prix', 'Belgian GP', 'BEL'),
    ('ambiguous_grand_prix', 'Ambiguous Grand Prix', 'Formula 1 Ambiguous Grand Prix', 'Ambiguous GP', 'AMB')`);
  await pool.query(`INSERT INTO race (id, year, round, circuit_id, grand_prix_id, official_name, date) VALUES
    (1, 2025, 1, 'albert-park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2025-03-16'),
    (2, 2025, 2, 'monaco', 'monaco_grand_prix', 'Formula 1 Monaco Grand Prix', '2025-05-25'),
    (101, 2024, 1, 'albert-park', 'australian_grand_prix', 'Formula 1 Australian Grand Prix', '2024-03-24'),
    (8, 2025, 8, 'ambiguous-one', 'ambiguous_grand_prix', 'Formula 1 Ambiguous Grand Prix', '2025-06-01'),
    (9, 2025, 9, 'ambiguous-two', 'ambiguous_grand_prix', 'Formula 1 Ambiguous Grand Prix', '2025-06-08'),
    (18, 2025, 18, 'spa-one', 'belgian_grand_prix', 'Formula 1 Belgian Grand Prix', '2025-07-20'),
    (19, 2025, 19, 'spa-two', 'belgian_grand_prix', 'Formula 1 Belgian Grand Prix', '2025-07-27')`);
  await pool.query(`INSERT INTO race_data (race_id, type, driver_id, constructor_id, position_number, position_text, race_points, race_reason_retired) VALUES
    (1, 'RACE_RESULT', 'max_verstappen', 'red-bull', 1, '1', 25, NULL),
    (1, 'RACE_RESULT', 'sample_driver', 'sample', NULL, 'R', 0, 'Engine'),
    (1, 'RACE_RESULT', 'status_dns', 'sample', NULL, 'DNS', 0, 'DNS'),
    (1, 'RACE_RESULT', 'status_dsq', 'sample', NULL, 'DSQ', 0, 'Disqualified'),
    (1, 'RACE_RESULT', 'status_nc', 'sample', NULL, 'NC', 0, 'Not Classified'),
    (1, 'RACE_RESULT', 'status_withdrawn', 'sample', NULL, 'W', 0, 'Withdrawn'),
    (2, 'RACE_RESULT', 'charles_leclerc', 'ferrari', 1, '1', 25, NULL),
    (2, 'RACE_RESULT', 'lando_norris', 'mclaren', 2, '2', 18, NULL),
    (101, 'RACE_RESULT', 'lewis_hamilton', 'mercedes', 1, '1', 25, NULL),
    (101, 'RACE_RESULT', 'charles_leclerc', 'ferrari', 2, '2', 18, NULL)`);
  await pool.query(`INSERT INTO qualifying_results
    (season, round, driver_id, team_id, qualifying_position, best_time_ms, best_session, is_dnf, is_dns) VALUES
    (2025, 1, 'max_verstappen', 'red-bull', 1, 80000, 'Q3', false, false),
    (2025, 1, 'lando_norris', 'mclaren', NULL, NULL, NULL, false, true),
    (2025, 1, 'status_qual_dnf', 'sample', NULL, NULL, 'Q1', true, false),
    (2025, 2, 'lando_norris', 'mclaren', 1, 79000, 'Q3', false, false),
    (2025, 2, 'charles_leclerc', 'ferrari', 2, 79100, 'Q3', false, false),
    (2024, 1, 'lewis_hamilton', 'mercedes', 1, 80500, 'Q3', false, false),
    (2024, 1, 'charles_leclerc', 'ferrari', 2, 80600, 'Q3', false, false)`);
}
