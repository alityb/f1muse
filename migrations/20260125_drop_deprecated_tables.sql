-- Migration: Drop deprecated tables
-- Date: 2026-01-25
-- Purpose: Remove unused/deprecated tables identified in backend cleanup

BEGIN;

-- Drop deprecated driver reference table
-- (Replaced by F1DB drivers table or no longer needed)
DROP TABLE IF EXISTS drivers CASCADE;

-- Drop deprecated track reference table
-- (Replaced by F1DB circuits table or no longer needed)
DROP TABLE IF EXISTS tracks CASCADE;

-- Drop track aliases table
-- (No longer needed with current track resolution logic)
DROP TABLE IF EXISTS track_aliases CASCADE;

-- Drop driver season entries cache
-- (Deprecated - can be queried from F1DB driver_standings if needed)
DROP TABLE IF EXISTS driver_season_entries CASCADE;

COMMIT;
