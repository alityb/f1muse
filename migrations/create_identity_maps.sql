-- =====================================================
-- Identity Bridge Tables (F1DB ↔ FastF1 ingestion)
-- =====================================================

-- Driver identity bridge (ingestion -> F1DB)
CREATE TABLE IF NOT EXISTS driver_identity_map (
  ingestion_driver_id text PRIMARY KEY,
  f1db_driver_id text NOT NULL REFERENCES driver(id),
  canonical_name text,
  resolution_method text NOT NULL, -- alias | abbreviation | manual
  conflict_flag boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_identity_map_f1db
  ON driver_identity_map(f1db_driver_id);

-- Track identity bridge (ingestion -> F1DB)
CREATE TABLE IF NOT EXISTS track_identity_map (
  ingestion_track_id text PRIMARY KEY,
  f1db_circuit_id text REFERENCES circuit(id),
  f1db_grand_prix_id text REFERENCES grand_prix(id),
  resolution_method text NOT NULL,
  conflict_flag boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_track_identity_map_circuit
  ON track_identity_map(f1db_circuit_id);
CREATE INDEX IF NOT EXISTS idx_track_identity_map_gp
  ON track_identity_map(f1db_grand_prix_id);

-- -----------------------------------------------------
-- Deprecation markers (do not remove tables yet)
-- -----------------------------------------------------
COMMENT ON TABLE drivers IS 'DEPRECATED: use driver (F1DB) + driver_identity_map';
COMMENT ON TABLE tracks IS 'DEPRECATED: use circuit/grand_prix (F1DB) + track_identity_map';
COMMENT ON TABLE track_aliases IS 'DEPRECATED: use circuit/grand_prix (F1DB) + track_identity_map';
COMMENT ON TABLE driver_season_entries IS 'DEPRECATED: use season_entrant_driver (F1DB)';
