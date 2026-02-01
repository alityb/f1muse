# architecture

## system overview

```
user question (natural language)
       │
       ▼
   llm service (claude / mistral-rs)
       │
       ▼
   queryintent (json)
       │
       ▼
   f1muse api
       │
       ├── validation layer
       │   ├── schema validation
       │   ├── identity resolution
       │   └── semantic rules
       │
       ├── execution layer
       │   ├── template selection
       │   ├── parameter binding
       │   └── sql execution
       │
       └── response layer
           ├── result formatting
           ├── confidence scoring
           └── interpretation building
       │
       ▼
   postgresql (read-only)
```

two-tier design:
- **llm layer**: creative, parses natural language, generates queryintent candidates
- **api layer**: deterministic, validates, executes approved templates only

the api never trusts llm output. all queryintent objects are validated before execution.

---

## request flow

### 1. queryintent validation

```
src/validation/query-validator.ts
```

validates:
- required fields present
- season is valid (2022-2025)
- metric matches query kind
- normalization matches query kind

### 2. identity resolution

```
src/identity/driver-resolver.ts
src/identity/track-resolver.ts
```

resolves natural names to database ids:
- "max verstappen" → "max_verstappen"
- "silverstone" → "silverstone"
- "japan" → "suzuka"

fails on ambiguous inputs ("charles" when multiple charles exist).

### 3. template selection

```
src/execution/query-executor.ts
```

maps queryintent kind to approved sql template:
- `track_scoped_driver_comparison` → `track_scoped_driver_comparison_v1.sql`
- `driver_pole_count` → `driver_pole_count_v1.sql`

### 4. parameter binding

binds resolved identifiers to sql parameters ($1, $2, etc).
no string interpolation. no dynamic sql.

### 5. sql execution

```
src/database/pool.ts
```

read-only connection pool. all writes go through etl scripts, not api.

### 6. result formatting

```
src/execution/result-formatter.ts
```

transforms raw sql rows into typed response payloads.

### 7. confidence scoring

```
src/execution/confidence-analyzer.ts
```

computes confidence based on:
- lap count coverage
- data freshness
- query complexity

levels: high, medium, low, insufficient

---

## queryintent kinds

19 supported query types:

| kind | description |
|------|-------------|
| driver_teammate_comparison_season | compare teammates (same team) |
| cross_team_driver_comparison_season | compare drivers (different teams) |
| track_scoped_driver_comparison | compare at specific track |
| driver_ranking_track | rank drivers at track |
| teammate_gap_summary_season | full-season teammate gap |
| season_driver_summary | single driver season stats |
| driver_career_summary | career stats |
| driver_pole_count | pole position count |
| driver_q3_count | q3 appearance count |
| season_q3_rankings | rank by q3 appearances |
| qualifying_gap_teammates | teammate qualifying gap |
| qualifying_gap_drivers | cross-team qualifying gap |
| head_to_head_track | head-to-head at track |
| head_to_head_season | head-to-head across season |

---

## sql templates

all templates in `templates/` directory. naming convention:

```
{query_kind}_v{version}.sql
```

templates use postgresql parameterized queries:
- `$1`, `$2` for bound parameters
- no string concatenation
- no dynamic table/column names

example template structure:

```sql
-- parameters: $1=season, $2=driver_id
select
  driver_id,
  count(*) filter (where official_grid_position = 1) as pole_count
from qualifying_results_official
where season = $1 and driver_id = $2
group by driver_id;
```

---

## caching

### redis cache

```
src/cache/redis-cache.ts
src/cache/query-cache.ts
```

optional redis caching for query results.

cache key: hash of queryintent json
ttl: based on confidence level
- high confidence: 7 days
- medium confidence: 3 days
- low confidence: 1 day

### cache invalidation

automatic invalidation on:
- etl completion
- data corrections

---

## llm integration

### claude (anthropic)

```
src/llm/claude-client.ts
```

cloud api. requires `ANTHROPIC_API_KEY`.

### query translation

```
src/llm/query-translator.ts
```

system prompt instructs llm to:
1. parse user question
2. extract driver names, track names, season
3. map to queryintent kind
4. output json only

the api validates llm output. invalid queryintent is rejected.

---

## database schema

### core tables

**laps_normalized**
```sql
season, round, track_id, driver_id, lap_number
stint_id, stint_lap_index, lap_time_seconds
is_valid_lap, is_pit_lap, is_out_lap, is_in_lap
clean_air_flag, compound, tyre_age_laps
```

**qualifying_results**
```sql
season, round, driver_id, team_id, track_id
qualifying_position, grid_position
q1_time_ms, q2_time_ms, q3_time_ms, best_time_ms
eliminated_in_round, is_dnf, is_dns, session_type
```

**qualifying_grid_corrections**
```sql
season, round, driver_id
qualifying_position    -- by lap time
official_grid_position -- fia starting position
reason, source
```

### views

**qualifying_results_official**

joins qualifying_results with grid_corrections to provide fia-accurate positions:

```sql
select
  qr.*,
  coalesce(gc.official_grid_position, qr.qualifying_position) as official_grid_position,
  gc.official_grid_position is not null as has_grid_correction
from qualifying_results qr
left join qualifying_grid_corrections gc
  on qr.season = gc.season and qr.round = gc.round and qr.driver_id = gc.driver_id
```

---

## error handling

### validation errors

returned when queryintent fails validation:

```json
{
  "error": "validation_failed",
  "reason": "season is required for track-scoped queries"
}
```

### execution errors

returned when sql execution fails:

```json
{
  "error": "execution_failed",
  "reason": "insufficient data for comparison"
}
```

### identity resolution errors

returned when driver/track cannot be resolved:

```json
{
  "error": "intent_resolution_failed",
  "reason": "unknown driver: fakedriver"
}
```

---

## security

### sql injection prevention

- no dynamic sql generation
- only approved templates executed
- parameterized queries with pg library
- read-only database connection

### llm output handling

- llm output treated as untrusted input
- all queryintent validated before execution
- raw llm output logged for audit

### rate limiting

recommended for production:
- `/nl-query`: 10 req/min (llm calls are expensive)
- `/query`: 100 req/min
