# F1Muse Capability Matrix

Status: Phase 0 baseline
Purpose: Define what the current template architecture can answer, what data
authorities it uses, and where F1QL must extend it.

## Coverage Boundaries

| Data class | Current coverage | Authority | Notes |
|---|---|---|---|
| Race classification | 1950-present, source-dependent | F1DB; Jolpica for current season | Includes finish classification and race points |
| Official season standings | 1950-present, source-dependent | `season_driver_standing` | Authoritative for championship points and rank |
| Qualifying classification | historical coverage varies; robust current pipeline | F1DB / FastF1 | Pole is qualifying P1, not necessarily official grid P1 |
| Lap pace, stints, compounds | 2018-present | FastF1 | No lap-based answer before 2018 |
| Current-season results and standings | Latest successful sync | Jolpica | Subject to upstream publication and pagination completeness |
| Current-season laps/qualifying | Latest successful FastF1 ETL | FastF1 | May lag race results |

## Current Query Surface

| Statistical family | Current implementation | Main limitation |
|---|---|---|
| Race/qualifying result lookup | Result-summary templates | Fixed season + event shape |
| Official driver season totals | `driver_season_summary` | No arbitrary filters or intervals |
| Career totals | Career templates | Fixed aggregation definitions |
| Driver-vs-driver season pace | Normalized/raw season templates | No arbitrary round, stint, compound, or weather scopes |
| Track comparison/ranking | Track templates | One track scope at a time |
| Teammate gap | Precomputed teammate templates | Full-season or fixed scope only |
| Head-to-head counts | Conditional H2H template | Has filters, but only classification H2H |
| Pole/Q3 counts | Qualifying templates | Fixed aggregation shapes |
| Multi-driver pace ranking | Multi-comparison template | Fixed metrics and small driver sets |

## Current Correctness Authorities

| Fact | Current authoritative relation | Regression concern |
|---|---|---|
| Championship points | `season_driver_standing.points` | Never substitute summed race rows when official standing exists |
| Wins, podiums, classified finishes | `race_data` / race classification | `Lapped` is classified; DNS/W are not positions |
| Pole positions | `qualifying_results.qualifying_position = 1` | Do not confuse with post-penalty grid position |
| Pace | `laps_normalized` | Valid, non-pit, non-in/out lap rules must be explicit |
| Seasonal eligibility | `season_driver_standing` today; future `f1.season_entries` | Do not emit zero-filled comparisons for absent entrants |

## Explicit Current Limitations

1. Query capability grows by adding an intent plus a template. It does not
   compose filters across query families.
2. A natural-language model can only route to existing query kinds; it cannot
   create a new deterministic calculation safely.
3. Historical classification and current lap data have different coverage.
   A query can be answerable for results but not for pace.
4. Raw table identity formats still vary by source (hyphen/underscore driver
   IDs and circuit/grand-prix track IDs).
5. Cache correctness currently depends on explicit version bumps and manual
   invalidation after methodology changes.

## F1QL v1 Target Delta

| Capability | Current | F1QL v1 target |
|---|---|---|
| Scope | Fixed per template | Composable season, round, event, session, and entity filters |
| Calculation | Template-specific SQL | Typed composition of source/filter/group/aggregate/compare/delta/rank/window |
| Coverage | Inconsistent per template | One participation and coverage gate before execution |
| Explanation | Bespoke formatter text | Renderer derived from the program AST |
| Cache key | Intent/query-shape dependent | Normalized program + data/definition/ontology versions |
| LLM role | Intent classification | Optional language-to-program translation only |

## Phase 0 Inventory

- Query templates: 27 SQL files.
- Public query abstraction: `QueryIntent` union with legacy per-kind routing.
- Existing validation: metric registry, query validator, driver/track
  resolvers, template selection, parameter binding, coverage/confidence.
- Existing cache layers: Redis result/intent cache and Postgres
  `api_query_cache`.
- Existing sync sources: F1DB import, FastF1 ETL, Jolpica current-season sync.
- Existing operational protections: authenticated admin endpoints,
  `ADMIN_API_KEY`, optional Redis, Railway health checks.

## Test Evidence Status

- The current incident registry is intentionally **provisional**. Its values
  are not release-blocking until each case has independent evidence, a local
  fixture/snapshot, and an executable runner.
- The initial local runner uses adversarial synthetic data to prove source
  authority and refusal behavior at the SQL-template boundary.
- A future production runner must use a dedicated read-only endpoint or
  snapshot database. It must never run test writes against production.

### Local Contract Gate

Run the complete local golden suite with Docker Desktop running:

```bash
npm run test:golden:db
```

The command starts a disposable PostgreSQL 16 instance, waits on an actual
database readiness probe, runs `tests/golden`, and tears the instance down
even when the test command fails.

## Phase 0 Exit Criteria

- Every new F1QL feature cites a row in this matrix as its source capability
  or explicitly extends the matrix.
- Every missing-data response identifies whether the limit is coverage,
  participation, source freshness, or language expressibility.
