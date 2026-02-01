# f1muse

deterministic f1 analytics api. validates and executes structured queryintent objects against postgresql. no dynamic sql generation.

for system design and data model, see [docs/architecture.md](docs/architecture.md).
for etl pipelines and operations, see [docs/operations.md](docs/operations.md).

---

## what it does

- executes validated queryintent json against approved sql templates
- resolves driver and track identities from natural names
- enforces semantic rules (teammates must share team, season required)
- computes confidence scores based on data coverage
- optional: translates natural language to queryintent via llm

---

## quickstart

### prerequisites

- node.js 20+
- postgresql 14+
- python 3.10+ (for etl)

### setup

```bash
git clone <repo>
cd f1muse
npm install
```

### configuration

create `.env`:

```bash
# required
DATABASE_URL=postgresql://user:pass@localhost:5432/f1muse

# optional: test database
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/f1muse_test

# optional: natural language queries
ANTHROPIC_API_KEY=sk-ant-...

# optional: redis caching
REDIS_URL=redis://localhost:6379
```

### run locally

```bash
npm run dev
```

server starts on port 3000.

### run migrations

```bash
psql $DATABASE_URL < migrations/20260126_create_qualifying_tables.sql
psql $DATABASE_URL < migrations/20260128_add_qualifying_grid_corrections.sql
```

### load data

```bash
# python etl (lap data)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
npm run etl:laps:all

# typescript etl (pace metrics, teammate gaps)
npm run etl:pace-metrics
npm run ingest:teammate-gap:2025
```

---

## api

### endpoints

| method | path | description |
|--------|------|-------------|
| POST | /query | execute queryintent |
| POST | /nl-query | natural language query (requires llm) |
| GET | /health | health check |
| GET | /health/detailed | detailed health with db stats |
| GET | /capabilities | list supported query kinds |
| GET | /suggestions | example queries by category |

### execute query

```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "track_scoped_driver_comparison",
    "season": 2025,
    "track_id": "silverstone",
    "driver_a_id": "verstappen",
    "driver_b_id": "norris",
    "metric": "avg_true_pace",
    "normalization": "none",
    "clean_air_only": false,
    "compound_context": "mixed",
    "session_scope": "race"
  }'
```

### natural language query

```bash
curl -X POST http://localhost:3000/nl-query \
  -H "Content-Type: application/json" \
  -d '{"question": "who was faster at silverstone, max or lando?"}'
```

---

## data

### database

postgresql with read-only api connections. tables:

| table | purpose |
|-------|---------|
| laps_normalized | lap-level telemetry from fastf1 |
| pace_metrics_2025 | aggregated pace statistics |
| qualifying_results | qualifying session results (q1/q2/q3 times) |
| qualifying_grid_corrections | fia-accurate grid positions after penalties |
| teammate_gap_season_summary_2025 | season teammate gap analysis |
| drivers, circuits, constructors | f1db reference data |

### grid corrections

fastf1 returns qualifying classification (by lap time), not official fia starting grid. the system maintains corrections for:

- engine/gearbox penalties
- impeding penalties
- pit lane starts
- disqualifications

388 corrections across 2022-2025. see [docs/operations.md](docs/operations.md) for details.

### etl sources

- **fastf1**: lap times, tire data, pit stops
- **jolpica api**: race results, grid positions
- **f1db**: driver/team/circuit reference data

---

## development

### tests

```bash
npm test                    # all tests
npm run test:coverage       # with coverage
npx vitest src/test/x.ts    # specific file
```

### lint

```bash
npm run lint
```

### typecheck

```bash
npm run typecheck
```

### migrations

```bash
psql $DATABASE_URL < migrations/<file>.sql
```

### etl commands

```bash
npm run etl:laps:all              # all race lap data
npm run etl:laps:round 1          # specific round
npm run etl:pace-metrics          # pace metrics
npm run ingest:teammate-gap:2025  # teammate gaps
```

---

## key directories

| path | purpose |
|------|---------|
| src/api/ | http routes and middleware |
| src/execution/ | query execution engine |
| src/identity/ | driver and track resolution |
| src/llm/ | llm clients and translation |
| src/validation/ | queryintent validation |
| src/types/ | typescript type definitions |
| src/etl/ | data ingestion pipelines |
| templates/ | approved sql templates |
| migrations/ | database migrations |
| scripts/ | operational scripts |
