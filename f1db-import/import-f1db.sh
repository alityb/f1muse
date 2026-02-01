#!/bin/bash
# Import f1db into Supabase (2020-2025 data only)

set -e

DB_URL="postgresql://postgres:nbr%2ACGW8hqr.eyr6daq@db.omhhvdgbvxjkbnaxnmsj.supabase.co:5432/postgres"

echo "=== F1DB IMPORT (2020-2025) ==="
echo ""
echo "Step 1: Creating schema..."

# Extract and load schema (CREATE TABLE statements only)
grep -A 1000 "CREATE TABLE" f1db-sql-postgresql.sql | \
  grep -B 5 -A 1000 "^CREATE TABLE" | \
  awk '/^CREATE TABLE/,/^);$/' > f1db-schema-only.sql

# Add DROP IF EXISTS for idempotency
cat > f1db-schema-with-drops.sql << 'SCHEMA'
-- Drop existing f1db tables if they exist
DROP TABLE IF EXISTS race_constructor_standing CASCADE;
DROP TABLE IF EXISTS race_driver_standing CASCADE;
DROP TABLE IF EXISTS race_data CASCADE;
DROP TABLE IF EXISTS race CASCADE;
DROP TABLE IF EXISTS season_constructor_standing CASCADE;
DROP TABLE IF EXISTS season_driver_standing CASCADE;
DROP TABLE IF EXISTS season_entrant_tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS season_entrant_engine CASCADE;
DROP TABLE IF EXISTS season_entrant_chassis CASCADE;
DROP TABLE IF EXISTS season_entrant_constructor CASCADE;
DROP TABLE IF EXISTS season_entrant_driver CASCADE;
DROP TABLE IF EXISTS season_entrant CASCADE;
DROP TABLE IF EXISTS season_tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS season_engine_manufacturer CASCADE;
DROP TABLE IF EXISTS season_constructor CASCADE;
DROP TABLE IF EXISTS season_driver CASCADE;
DROP TABLE IF EXISTS season CASCADE;
DROP TABLE IF EXISTS grand_prix CASCADE;
DROP TABLE IF EXISTS circuit CASCADE;
DROP TABLE IF EXISTS entrant CASCADE;
DROP TABLE IF EXISTS tyre_manufacturer CASCADE;
DROP TABLE IF EXISTS engine CASCADE;
DROP TABLE IF EXISTS engine_manufacturer CASCADE;
DROP TABLE IF EXISTS chassis CASCADE;
DROP TABLE IF EXISTS constructor_chronology CASCADE;
DROP TABLE IF EXISTS constructor CASCADE;
DROP TABLE IF EXISTS driver_family_relationship CASCADE;
DROP TABLE IF EXISTS driver CASCADE;
DROP TABLE IF EXISTS country CASCADE;
DROP TABLE IF EXISTS continent CASCADE;

SCHEMA

cat f1db-schema-only.sql >> f1db-schema-with-drops.sql

echo "Loading schema..."
PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres < f1db-schema-with-drops.sql

echo ""
echo "Step 2: Loading reference data (all years)..."

# Load reference tables (no year filter needed)
for table in continent country driver driver_family_relationship constructor constructor_chronology chassis engine_manufacturer engine tyre_manufacturer entrant circuit grand_prix; do
  echo "  Loading $table..."
  grep "INSERT INTO \"$table\"" f1db-sql-postgresql.sql | \
    PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -q
done

echo ""
echo "Step 3: Loading season data (2020-2025 only)..."

# Load season table (2020-2025)
grep "INSERT INTO \"season\"" f1db-sql-postgresql.sql | \
  grep -E "2020|2021|2022|2023|2024|2025" | \
  PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -q

echo ""
echo "Step 4: Loading race data (2020-2025 only)..."

# Extract race IDs for 2020-2025 seasons
echo "  Extracting 2020-2025 race IDs..."
grep "INSERT INTO \"race\"" f1db-sql-postgresql.sql > all_races.sql

# Filter races by year (assuming race ID format includes year)
grep -E "2020|2021|2022|2023|2024|2025" all_races.sql | \
  PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -q

echo ""
echo "Step 5: Loading season-specific tables (2020-2025)..."

# These tables reference season year, filter them
for table in season_constructor season_driver season_engine_manufacturer season_tyre_manufacturer season_entrant season_entrant_constructor season_entrant_chassis season_entrant_engine season_entrant_tyre_manufacturer season_entrant_driver season_driver_standing season_constructor_standing; do
  echo "  Loading $table (filtered)..."
  grep "INSERT INTO \"$table\"" f1db-sql-postgresql.sql | \
    grep -E "2020|2021|2022|2023|2024|2025" | \
    PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -q || true
done

echo ""
echo "Step 6: Loading race-specific tables (2020-2025)..."

for table in race_data race_driver_standing race_constructor_standing; do
  echo "  Loading $table (filtered)..."
  grep "INSERT INTO \"$table\"" f1db-sql-postgresql.sql | \
    grep -E "2020|2021|2022|2023|2024|2025" | \
    PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -q || true
done

echo ""
echo "=== IMPORT COMPLETE ==="
echo ""
echo "Verifying data..."
PGPASSWORD='nbr*CGW8hqr.eyr6daq' psql -h db.omhhvdgbvxjkbnaxnmsj.supabase.co -U postgres -d postgres -c "SELECT year, COUNT(*) FROM race GROUP BY year ORDER BY year DESC LIMIT 10;"

