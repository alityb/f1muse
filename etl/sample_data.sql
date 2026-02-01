-- Quick sample data for testing F1 Muse API
-- Run this if you want to test the API while waiting for full ETL

-- Clear existing data (optional)
-- TRUNCATE drivers, driver_aliases, tracks, track_aliases, driver_season_entries,
--          pace_metric_summary_driver_season, pace_metric_summary_driver_track CASCADE;

-- Insert sample drivers
INSERT INTO drivers (driver_id, code, first_name, last_name, full_name) VALUES
  ('VER', 'VER', 'Max', 'Verstappen', 'Max Verstappen'),
  ('PER', 'PER', 'Sergio', 'Perez', 'Sergio Perez'),
  ('LEC', 'LEC', 'Charles', 'Leclerc', 'Charles Leclerc'),
  ('SAI', 'SAI', 'Carlos', 'Sainz', 'Carlos Sainz'),
  ('HAM', 'HAM', 'Lewis', 'Hamilton', 'Lewis Hamilton'),
  ('RUS', 'RUS', 'George', 'Russell', 'George Russell'),
  ('ALO', 'ALO', 'Fernando', 'Alonso', 'Fernando Alonso'),
  ('STR', 'STR', 'Lance', 'Stroll', 'Lance Stroll'),
  ('NOR', 'NOR', 'Lando', 'Norris', 'Lando Norris'),
  ('PIA', 'PIA', 'Oscar', 'Piastri', 'Oscar Piastri')
ON CONFLICT (driver_id) DO NOTHING;

-- Insert driver aliases
INSERT INTO driver_aliases (alias, driver_id, is_primary) VALUES
  ('Max', 'VER', false),
  ('Verstappen', 'VER', false),
  ('Max Verstappen', 'VER', true),
  ('VER', 'VER', false),
  ('Charles', 'LEC', false),
  ('Leclerc', 'LEC', false),
  ('Charles Leclerc', 'LEC', true),
  ('LEC', 'LEC', false),
  ('Carlos', 'SAI', false),
  ('Sainz', 'SAI', false),
  ('Carlos Sainz', 'SAI', true),
  ('SAI', 'SAI', false),
  ('Fernando', 'ALO', false),
  ('Alonso', 'ALO', false),
  ('Fernando Alonso', 'ALO', true),
  ('ALO', 'ALO', false),
  ('Lando', 'NOR', false),
  ('Norris', 'NOR', false),
  ('Lando Norris', 'NOR', true),
  ('NOR', 'NOR', false),
  ('Oscar', 'PIA', false),
  ('Piastri', 'PIA', false),
  ('Oscar Piastri', 'PIA', true),
  ('PIA', 'PIA', false)
ON CONFLICT (alias) DO NOTHING;

-- Insert sample tracks
INSERT INTO tracks (track_id, track_name, country) VALUES
  ('bahrain', 'Bahrain International Circuit', 'Bahrain'),
  ('jeddah', 'Jeddah Corniche Circuit', 'Saudi Arabia'),
  ('albert_park', 'Albert Park Circuit', 'Australia'),
  ('suzuka', 'Suzuka International Racing Course', 'Japan'),
  ('shanghai', 'Shanghai International Circuit', 'China'),
  ('miami', 'Miami International Autodrome', 'United States'),
  ('imola', 'Autodromo Enzo e Dino Ferrari', 'Italy'),
  ('monaco', 'Circuit de Monaco', 'Monaco'),
  ('montmelo', 'Circuit de Barcelona-Catalunya', 'Spain')
ON CONFLICT (track_id) DO NOTHING;

-- Insert track aliases
INSERT INTO track_aliases (alias, track_id, is_primary) VALUES
  ('Bahrain', 'bahrain', false),
  ('Bahrain International Circuit', 'bahrain', true),
  ('Sakhir', 'bahrain', false),
  ('Jeddah', 'jeddah', false),
  ('Jeddah Corniche Circuit', 'jeddah', true),
  ('Saudi Arabia', 'jeddah', false),
  ('Suzuka', 'suzuka', true),
  ('Japan', 'suzuka', false),
  ('Suzuka International Racing Course', 'suzuka', false),
  ('Monaco', 'monaco', true),
  ('Monte Carlo', 'monaco', false),
  ('Circuit de Monaco', 'monaco', false)
ON CONFLICT (alias) DO NOTHING;

-- Insert sample team memberships (2024 season)
INSERT INTO driver_season_entries (season, driver_id, team_id) VALUES
  (2024, 'VER', 'RBR'),
  (2024, 'PER', 'RBR'),
  (2024, 'LEC', 'FER'),
  (2024, 'SAI', 'FER'),
  (2024, 'HAM', 'MER'),
  (2024, 'RUS', 'MER'),
  (2024, 'ALO', 'AMR'),
  (2024, 'STR', 'AMR'),
  (2024, 'NOR', 'MCL'),
  (2024, 'PIA', 'MCL')
ON CONFLICT (season, driver_id) DO NOTHING;

-- Insert sample season metrics (realistic 2024 data)
INSERT INTO pace_metric_summary_driver_season
  (season, driver_id, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
VALUES
  -- Red Bull teammates
  (2024, 'VER', 'driver_above_baseline', 0.25, 'team_baseline', 450, false, 'mixed', 'all'),
  (2024, 'PER', 'driver_above_baseline', -0.15, 'team_baseline', 420, false, 'mixed', 'all'),

  -- Ferrari teammates
  (2024, 'LEC', 'driver_above_baseline', 0.12, 'team_baseline', 440, false, 'mixed', 'all'),
  (2024, 'SAI', 'driver_above_baseline', -0.08, 'team_baseline', 435, false, 'mixed', 'all'),

  -- Mercedes teammates
  (2024, 'HAM', 'driver_above_baseline', 0.05, 'team_baseline', 448, false, 'mixed', 'all'),
  (2024, 'RUS', 'driver_above_baseline', -0.02, 'team_baseline', 452, false, 'mixed', 'all'),

  -- McLaren teammates
  (2024, 'NOR', 'driver_above_baseline', 0.18, 'team_baseline', 455, false, 'mixed', 'all'),
  (2024, 'PIA', 'driver_above_baseline', -0.10, 'team_baseline', 447, false, 'mixed', 'all'),

  -- Aston Martin teammates
  (2024, 'ALO', 'driver_above_baseline', 0.20, 'team_baseline', 430, false, 'mixed', 'all'),
  (2024, 'STR', 'driver_above_baseline', -0.15, 'team_baseline', 425, false, 'mixed', 'all')
ON CONFLICT (season, driver_id, metric_name, normalization, compound_context, clean_air_only, session_scope)
DO UPDATE SET metric_value = EXCLUDED.metric_value, laps_considered = EXCLUDED.laps_considered;

-- Insert sample track metrics (Bahrain 2024)
INSERT INTO pace_metric_summary_driver_track
  (season, track_id, driver_id, metric_name, metric_value, normalization, laps_considered, clean_air_only, compound_context, session_scope)
VALUES
  (2024, 'bahrain', 'VER', 'avg_true_pace', 94.2, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'PER', 'avg_true_pace', 94.8, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'LEC', 'avg_true_pace', 94.5, 'none', 56, false, 'mixed', 'race'),
  (2024, 'bahrain', 'SAI', 'avg_true_pace', 94.7, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'HAM', 'avg_true_pace', 95.1, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'RUS', 'avg_true_pace', 95.2, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'NOR', 'avg_true_pace', 94.9, 'none', 56, false, 'mixed', 'race'),
  (2024, 'bahrain', 'PIA', 'avg_true_pace', 95.0, 'none', 57, false, 'mixed', 'race'),
  (2024, 'bahrain', 'ALO', 'avg_true_pace', 95.3, 'none', 55, false, 'mixed', 'race'),
  (2024, 'bahrain', 'STR', 'avg_true_pace', 95.6, 'none', 56, false, 'mixed', 'race'),

  -- Suzuka 2024
  (2024, 'suzuka', 'VER', 'avg_true_pace', 91.5, 'none', 53, false, 'mixed', 'race'),
  (2024, 'suzuka', 'PER', 'avg_true_pace', 92.0, 'none', 53, false, 'mixed', 'race'),
  (2024, 'suzuka', 'LEC', 'avg_true_pace', 91.8, 'none', 52, false, 'mixed', 'race'),
  (2024, 'suzuka', 'SAI', 'avg_true_pace', 91.9, 'none', 53, false, 'mixed', 'race'),
  (2024, 'suzuka', 'ALO', 'avg_true_pace', 92.1, 'none', 53, false, 'mixed', 'race'),
  (2024, 'suzuka', 'NOR', 'avg_true_pace', 91.7, 'none', 52, false, 'mixed', 'race'),

  -- Monaco 2024
  (2024, 'monaco', 'LEC', 'avg_true_pace', 74.2, 'none', 78, false, 'mixed', 'race'),
  (2024, 'monaco', 'SAI', 'avg_true_pace', 74.5, 'none', 78, false, 'mixed', 'race'),
  (2024, 'monaco', 'NOR', 'avg_true_pace', 74.3, 'none', 77, false, 'mixed', 'race'),
  (2024, 'monaco', 'VER', 'avg_true_pace', 74.6, 'none', 78, false, 'mixed', 'race'),
  (2024, 'monaco', 'ALO', 'avg_true_pace', 74.8, 'none', 76, false, 'mixed', 'race')
ON CONFLICT (season, track_id, driver_id, metric_name, compound_context, clean_air_only, session_scope)
DO UPDATE SET metric_value = EXCLUDED.metric_value, laps_considered = EXCLUDED.laps_considered;

-- Success message
SELECT '✅ Sample data inserted successfully!' as status,
       (SELECT COUNT(*) FROM drivers) as drivers,
       (SELECT COUNT(*) FROM driver_aliases) as aliases,
       (SELECT COUNT(*) FROM tracks) as tracks,
       (SELECT COUNT(*) FROM pace_metric_summary_driver_track) as track_metrics,
       (SELECT COUNT(*) FROM pace_metric_summary_driver_season) as season_metrics;
