#!/bin/bash
# Safe, non-destructive F1DB import for required public tables.
# - No drops
# - Idempotent inserts (ON CONFLICT DO NOTHING/UPDATE)
# - Supports 2020-2025 season scope

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="${ROOT_DIR}/f1db-import/f1db-sql-postgresql.sql"

if [[ ! -f "${SQL_FILE}" ]]; then
  echo "Missing F1DB SQL file: ${SQL_FILE}" >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f "${ROOT_DIR}/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${ROOT_DIR}/.env"
    set +a
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL not set." >&2
  exit 1
fi

echo "=== SAFE F1DB IMPORT (2020-2025) ==="

SCHEMA_ONLY="${ROOT_DIR}/f1db-import/f1db-schema-only.sql"
SCHEMA_SAFE="${ROOT_DIR}/f1db-import/f1db-schema-safe.sql"

echo "-> Ensuring schema exists (CREATE TABLE IF NOT EXISTS)"
python3 - "${SQL_FILE}" "${SCHEMA_ONLY}" <<'PY'
import sys

source, target = sys.argv[1], sys.argv[2]
in_table = False
with open(source, 'r', encoding='utf-8') as infile, open(target, 'w', encoding='utf-8') as out:
    for line in infile:
        if line.startswith('CREATE TABLE'):
            in_table = True
        if in_table:
            out.write(line)
        if in_table and line.strip() == ');':
            out.write('\n')
            in_table = False
PY
sed -E 's/^CREATE TABLE /CREATE TABLE IF NOT EXISTS /' "${SCHEMA_ONLY}" > "${SCHEMA_SAFE}"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${SCHEMA_SAFE}"

echo "-> Ensuring driver columns exist"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE driver ADD COLUMN IF NOT EXISTS permanent_number varchar(2);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS gender varchar(6);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS date_of_death date;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS place_of_birth varchar(100);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS country_of_birth_country_id varchar(100);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS nationality_country_id varchar(100);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS second_nationality_country_id varchar(100);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS best_championship_position int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS best_starting_grid_position int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS best_race_result int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS best_sprint_race_result int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_championship_wins int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_entries int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_starts int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_wins int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_race_laps int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_podiums int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_points numeric(8,2);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_championship_points numeric(8,2);
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_pole_positions int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_fastest_laps int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_sprint_race_starts int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_sprint_race_wins int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_driver_of_the_day int;
ALTER TABLE driver ADD COLUMN IF NOT EXISTS total_grand_slams int;
SQL

echo "-> Ensuring circuit columns exist"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS type varchar(6);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS direction varchar(14);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS place_name varchar(100);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS country_id varchar(100);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS latitude numeric(10,6);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS longitude numeric(10,6);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS length numeric(6,3);
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS turns int;
ALTER TABLE circuit ADD COLUMN IF NOT EXISTS total_races_held int;
SQL

echo "-> Ensuring grand_prix columns exist"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE grand_prix ADD COLUMN IF NOT EXISTS country_id varchar(100);
ALTER TABLE grand_prix ADD COLUMN IF NOT EXISTS total_races_held int;
SQL

echo "-> Ensuring season_entrant_driver columns exist"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE season_entrant_driver ADD COLUMN IF NOT EXISTS engine_manufacturer_id varchar(100);
ALTER TABLE season_entrant_driver ADD COLUMN IF NOT EXISTS rounds varchar(100);
ALTER TABLE season_entrant_driver ADD COLUMN IF NOT EXISTS rounds_text varchar(100);
SQL

echo "-> Preparing insert batches"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

python3 - "${SQL_FILE}" "${TEMP_DIR}" <<'PY'
import os
import re
import sys

sql_file, out_dir = sys.argv[1], sys.argv[2]
year_re = re.compile(r'\b(2020|2021|2022|2023|2024|2025)\b')

ref_tables = {
    'continent',
    'country',
    'constructor',
    'engine_manufacturer',
    'tyre_manufacturer',
    'entrant',
    'circuit',
    'grand_prix'
}
season_tables = {
    'season',
    'season_entrant_driver',
    'season_driver_standing'
}

files = {}
for table in ref_tables:
    files[table] = open(os.path.join(out_dir, f'ref_{table}.sql'), 'w', encoding='utf-8')
for table in season_tables:
    files[table] = open(os.path.join(out_dir, f'season_{table}.sql'), 'w', encoding='utf-8')

driver_file = open(os.path.join(out_dir, 'driver_upsert.sql'), 'w', encoding='utf-8')
race_file = open(os.path.join(out_dir, 'race.sql'), 'w', encoding='utf-8')
race_data_stage = open(os.path.join(out_dir, 'race_data_stage.sql'), 'w', encoding='utf-8')

driver_update = (
    ' ON CONFLICT ("id") DO UPDATE SET '
    '"name"=EXCLUDED."name",'
    '"first_name"=EXCLUDED."first_name",'
    '"last_name"=EXCLUDED."last_name",'
    '"full_name"=EXCLUDED."full_name",'
    '"abbreviation"=EXCLUDED."abbreviation",'
    '"permanent_number"=EXCLUDED."permanent_number",'
    '"gender"=EXCLUDED."gender",'
    '"date_of_birth"=EXCLUDED."date_of_birth",'
    '"date_of_death"=EXCLUDED."date_of_death",'
    '"place_of_birth"=EXCLUDED."place_of_birth",'
    '"country_of_birth_country_id"=EXCLUDED."country_of_birth_country_id",'
    '"nationality_country_id"=EXCLUDED."nationality_country_id",'
    '"second_nationality_country_id"=EXCLUDED."second_nationality_country_id",'
    '"best_championship_position"=EXCLUDED."best_championship_position",'
    '"best_starting_grid_position"=EXCLUDED."best_starting_grid_position",'
    '"best_race_result"=EXCLUDED."best_race_result",'
    '"best_sprint_race_result"=EXCLUDED."best_sprint_race_result",'
    '"total_championship_wins"=EXCLUDED."total_championship_wins",'
    '"total_race_entries"=EXCLUDED."total_race_entries",'
    '"total_race_starts"=EXCLUDED."total_race_starts",'
    '"total_race_wins"=EXCLUDED."total_race_wins",'
    '"total_race_laps"=EXCLUDED."total_race_laps",'
    '"total_podiums"=EXCLUDED."total_podiums",'
    '"total_points"=EXCLUDED."total_points",'
    '"total_championship_points"=EXCLUDED."total_championship_points",'
    '"total_pole_positions"=EXCLUDED."total_pole_positions",'
    '"total_fastest_laps"=EXCLUDED."total_fastest_laps",'
    '"total_sprint_race_starts"=EXCLUDED."total_sprint_race_starts",'
    '"total_sprint_race_wins"=EXCLUDED."total_sprint_race_wins",'
    '"total_driver_of_the_day"=EXCLUDED."total_driver_of_the_day",'
    '"total_grand_slams"=EXCLUDED."total_grand_slams"'
)

with open(sql_file, 'r', encoding='utf-8') as infile:
    for line in infile:
        if not line.startswith('INSERT INTO "'):
            continue
        table = line.split('"', 2)[1]

        if table == 'driver':
            driver_file.write(line.rstrip().rstrip(';') + driver_update + ';\n')
            continue

        if table in ref_tables:
            files[table].write(line.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING;\n')
            continue

        if table in season_tables:
            if year_re.search(line):
                files[table].write(line.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING;\n')
            continue

        if table == 'race':
            if year_re.search(line):
                race_file.write(line.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING;\n')
            continue

        if table == 'race_data':
            race_data_stage.write(line.replace('INSERT INTO "race_data"', 'INSERT INTO f1db_stage.race_data'))

for handle in files.values():
    handle.close()
driver_file.close()
race_file.close()
race_data_stage.close()
PY

echo "-> Loading reference tables (full history, idempotent)"
for table in continent country constructor engine_manufacturer tyre_manufacturer entrant circuit grand_prix; do
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${TEMP_DIR}/ref_${table}.sql"
done

echo "-> Loading driver table (full history, upsert)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${TEMP_DIR}/driver_upsert.sql"

echo "-> Loading season tables (2020-2025, idempotent)"
for table in season season_entrant_driver season_driver_standing; do
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${TEMP_DIR}/season_${table}.sql"
done

echo "-> Loading race table (2020-2025, idempotent)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${TEMP_DIR}/race.sql"

echo "-> Loading race data (staged, filtered to existing races)"
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS f1db_stage;
CREATE TABLE IF NOT EXISTS f1db_stage.race_data (LIKE race_data INCLUDING ALL);
TRUNCATE f1db_stage.race_data;
SQL

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "${TEMP_DIR}/race_data_stage.sql"

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO race_data
SELECT *
FROM f1db_stage.race_data
WHERE race_id IN (SELECT id FROM race)
ON CONFLICT (race_id, type, position_display_order) DO NOTHING;

TRUNCATE f1db_stage.race_data;
SQL

echo "=== SAFE IMPORT COMPLETE ==="
