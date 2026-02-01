-- Add missing 2025 driver rows for FastF1 ingestion + deterministic identity
-- Safe to run multiple times (ON CONFLICT DO NOTHING)

INSERT INTO driver (id, name, full_name, first_name, last_name, abbreviation)
VALUES
  ('alexander_albon', 'Albon', 'Alexander Albon', 'Alexander', 'Albon', 'ALB'),
  ('esteban_ocon', 'Ocon', 'Esteban Ocon', 'Esteban', 'Ocon', 'OCO'),
  ('franco_colapinto', 'Colapinto', 'Franco Colapinto', 'Franco', 'Colapinto', 'COL'),
  ('gabriel_bortoleto', 'Bortoleto', 'Gabriel Bortoleto', 'Gabriel', 'Bortoleto', 'BOR'),
  ('george_russell', 'Russell', 'George Russell', 'George', 'Russell', 'RUS'),
  ('isack_hadjar', 'Hadjar', 'Isack Hadjar', 'Isack', 'Hadjar', 'HAD'),
  ('jack_doohan', 'Doohan', 'Jack Doohan', 'Jack', 'Doohan', 'DOO'),
  ('kimi_antonelli', 'Antonelli', 'Kimi Antonelli', 'Kimi', 'Antonelli', 'ANT'),
  ('lance_stroll', 'Stroll', 'Lance Stroll', 'Lance', 'Stroll', 'STR'),
  ('liam_lawson', 'Lawson', 'Liam Lawson', 'Liam', 'Lawson', 'LAW'),
  ('nico_hulkenberg', 'Hulkenberg', 'Nico Hulkenberg', 'Nico', 'Hulkenberg', 'HUL'),
  ('oliver_bearman', 'Bearman', 'Oliver Bearman', 'Oliver', 'Bearman', 'BEA'),
  ('pierre_gasly', 'Gasly', 'Pierre Gasly', 'Pierre', 'Gasly', 'GAS'),
  ('yuki_tsunoda', 'Tsunoda', 'Yuki Tsunoda', 'Yuki', 'Tsunoda', 'TSU')
ON CONFLICT (id) DO NOTHING;
