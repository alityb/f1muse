# operations

## etl pipelines

### lap data ingestion

source: fastf1 python library

```bash
# install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# load all races
npm run etl:laps:all

# load specific round
npm run etl:laps:round 1
```

output table: `laps_normalized`

properties:
- idempotent (skips already-loaded races)
- transactional per race
- audited in `etl_runs_laps_normalized`

runtime:
- single race (cached): 5-10 seconds
- single race (uncached): 30-60 seconds
- full season: 30-60 minutes

### pace metrics

```bash
npm run etl:pace-metrics
```

computes aggregated pace statistics from lap data.

### qualifying ingestion

```bash
npm run etl:qualifying:2022
npm run etl:qualifying:2023
npm run etl:qualifying:2024
npm run etl:qualifying:2025
npm run etl:qualifying:all
```

loads q1/q2/q3 times, eliminated-in-round tracking.

### teammate gap ingestion

```bash
npm run ingest:teammate-gap:2025
```

computes season-level teammate gaps for race and qualifying pace.

---

## grid corrections

### background

fastf1 returns qualifying classification (ordered by lap time), not official fia starting grid (ordered by race start position). these differ due to:

- engine penalties (e.g., verstappen spa 2022: p1 → p14)
- gearbox penalties
- impeding penalties
- pit lane starts
- disqualifications

### data model

**qualifying_grid_corrections table**

```sql
create table qualifying_grid_corrections (
  season integer not null,
  round integer not null,
  driver_id text not null,
  qualifying_position integer not null,   -- by lap time
  official_grid_position integer not null, -- fia starting position
  reason text not null,
  source text default 'FIA',
  primary key (season, round, driver_id)
);
```

**qualifying_results_official view**

provides fia-accurate grid positions:

```sql
select
  qr.*,
  coalesce(gc.official_grid_position, qr.qualifying_position) as official_grid_position,
  gc.official_grid_position is not null as has_grid_correction
from qualifying_results qr
left join qualifying_grid_corrections gc
  on qr.season = gc.season and qr.round = gc.round and qr.driver_id = gc.driver_id
where qr.session_type = 'RACE_QUALIFYING';
```

### correction counts

| season | corrections | rounds affected |
|--------|-------------|-----------------|
| 2022 | 156 | 15 |
| 2023 | 108 | 13 |
| 2024 | 107 | 16 |
| 2025 | 17 | 3 |
| total | 388 | - |

### key races

**belgian gp (spa)** - engine penalty races:
- 2022 r14: verstappen p1→p14, leclerc p4→p15
- 2023 r12: verstappen p1→p6
- 2024 r14: verstappen p1→p11

**italian gp (monza)** - 2022 r16:
- verstappen p2→p7, sainz p3→p18, hamilton p5→p19

**qatar gp** - 2024 r23:
- verstappen p1→p2 (impeding penalty)

### populating corrections

```bash
# fetch from jolpica api + apply manual corrections
source .env && npx ts-node scripts/populate-grid-corrections.ts

# validate all corrections against api
source .env && npx ts-node scripts/validate-grid-corrections.ts

# sql verification queries
source .env && psql "$DATABASE_URL" -f scripts/verify-grid-corrections.sql
```

### data sources

primary: jolpica api (ergast successor)
- url: `https://api.jolpi.ca/ergast/f1/{season}/{round}/results.json`
- field: `Results[].grid` contains official starting position

secondary: manual corrections from fia documents

---

## migrations

### running migrations

```bash
psql $DATABASE_URL < migrations/<filename>.sql
```

### migration files

| file | purpose |
|------|---------|
| 20260126_create_qualifying_tables.sql | qualifying schema |
| 20260128_add_qualifying_grid_corrections.sql | grid corrections |

### creating migrations

naming convention:
```
YYYYMMDD_description.sql
```

requirements:
- idempotent (use `if not exists`, `on conflict do nothing`)
- include rollback comments
- document purpose in header

---

## testing

### test database setup

```bash
createdb f1muse_test
export TEST_DATABASE_URL="postgresql://localhost:5432/f1muse_test"
```

### running tests

```bash
# all tests
npm test

# with coverage
npm run test:coverage

# specific file
npx vitest src/test/<file>.test.ts

# single test by name
npx vitest -t "test name"

# watch mode
npx vitest --watch
```

### test categories

1. driver identity resolution
2. track identity resolution
3. required context rules
4. teammate comparison rules
5. cross-team comparison rules
6. track-scoped comparison
7. ranking validation
8. template safety (sql injection prevention)

### production validation tests

```bash
npm test -- --run tests/production/grid-position-historical.test.ts
npm test -- --run tests/production/pole-count-historical.test.ts
npm test -- --run tests/production/qualifying-session-type.test.ts
```

---

## validation scripts

### verify pole counts

validates pole position statistics match official fia results:

```bash
source .env && psql "$DATABASE_URL" -f scripts/verify-pole-counts.sql
```

### verify grid corrections

validates all grid corrections are complete and accurate:

```bash
source .env && npx ts-node scripts/validate-grid-corrections.ts
```

expected output:
```
✅ All grid corrections are complete and accurate!

2022: 0 missing, 0 incorrect
2023: 0 missing, 0 incorrect
2024: 0 missing, 0 incorrect
2025: 0 missing, 0 incorrect
```

---

## data quality checks

### lap data validation

```sql
-- lap counts per race
select round, count(*) as total_laps, count(distinct driver_id) as drivers
from laps_normalized
where season = 2025
group by round order by round;

-- pit lap ratio (target: 5-7%)
select round,
  100.0 * sum(case when is_pit_lap then 1 else 0 end) / count(*) as pit_lap_pct
from laps_normalized
where season = 2025
group by round order by round;

-- clean air ratio
select round,
  100.0 * sum(case when clean_air_flag then 1 else 0 end) / count(*) as clean_air_pct
from laps_normalized
where season = 2025 and is_valid_lap and not is_pit_lap
group by round order by round;
```

### qualifying data validation

```sql
-- qualifying results per season
select season, count(*) from qualifying_results
where session_type = 'RACE_QUALIFYING'
group by season order by season;

-- grid corrections per season
select season, count(*) from qualifying_grid_corrections
group by season order by season;

-- verstappen pole count verification
select season,
  count(*) filter (where official_grid_position = 1) as official_poles,
  count(*) filter (where qualifying_position = 1) as fastest_times
from qualifying_results_official
where driver_id = 'max_verstappen'
group by season order by season;
```

---

## troubleshooting

### fastf1 download fails

```
✗ HTTPError 503
```

causes: api rate limiting, server unavailable

solutions:
1. wait 5-10 minutes and retry
2. check fastf1 cache: `ls -la cache/fastf1/`
3. clear cache and retry: `rm -rf cache/fastf1/`

### missing lap data

```
✗ No lap data available
```

causes: race hasn't occurred, session type incorrect

solutions:
1. verify race has occurred
2. check fastf1 documentation for session types

### database connection failed

solutions:
1. verify postgresql is running
2. check DATABASE_URL in .env
3. verify database exists: `psql -l`

### grid corrections validation fails

```
❌ Missing corrections: X
```

solutions:
1. re-run population script: `npx ts-node scripts/populate-grid-corrections.ts`
2. check jolpica api availability
3. add manual corrections for edge cases

---

## monitoring

### health endpoints

```bash
# basic health
curl http://localhost:3000/health

# detailed health with db stats
curl http://localhost:3000/health/detailed
```

### key metrics

- query execution time
- validation failure rate
- llm translation success rate
- cache hit rate

### logs

query logging in `src/execution/query-logger.ts`:
- queryintent json
- execution time
- result row count
- errors

---

## backup and recovery

### database backup

```bash
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
```

### restore

```bash
psql $DATABASE_URL < backup_20260128.sql
```

### etl recovery

all etl scripts are idempotent. to re-ingest:

```bash
# delete existing data
psql $DATABASE_URL -c "delete from laps_normalized where season = 2025"

# re-run etl
npm run etl:laps:all
```
