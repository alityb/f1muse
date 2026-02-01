-- ============================================================================
-- Migration: Create driver_season_entries table
-- Created: 2026-01-26
-- Purpose: Create materialized lookup table for driver/season participation
-- ============================================================================

-- Create the table
CREATE TABLE IF NOT EXISTS driver_season_entries (
  driver_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  PRIMARY KEY (driver_id, year)
);

-- Create index for year lookups
CREATE INDEX IF NOT EXISTS idx_driver_season_entries_year
ON driver_season_entries(year);

-- Populate from season_entrant_driver (excluding test drivers)
INSERT INTO driver_season_entries (driver_id, year)
SELECT DISTINCT driver_id, year
FROM season_entrant_driver
WHERE test_driver IS NOT TRUE
ON CONFLICT (driver_id, year) DO NOTHING;

-- Verify the migration
DO $$
DECLARE
  entry_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO entry_count FROM driver_season_entries;
  RAISE NOTICE 'driver_season_entries populated with % entries', entry_count;
END $$;
