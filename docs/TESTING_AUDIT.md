# Testing Audit

Status: Baseline audit, 2026-07-18

## Required Release Gates

| Gate | Command | Status |
|---|---|---|
| Static types | `npm run typecheck` | Required |
| Lint errors | `npm run lint` | Required; complexity/size warnings are tracked debt |
| Unit and database behavior | `npm run test:unit:db:docker` | Required |
| Known incident contracts | `npm run test:golden:db` | Required |

The GitHub Actions workflow runs these gates for pull requests and `main`.

## Test Categories

| Category | Command | Meaning |
|---|---|---|
| Unit, DB-backed | `test:unit:db:docker` | Uses disposable local PostgreSQL; database unavailability is a failure |
| Golden contracts | `test:golden:db` | Source authority, participation refusal, pagination, and status semantics |
| DB integration | `test:integration:db` | Matchup, multi-driver, response contract, and cache integration |
| Template compatibility | `test:schema:db` | Every approved SQL template prepares against the current test schema |
| In-process HTTP | `test:api:inprocess` | Express routes tested with an ephemeral local listener, no manually started API |
| External HTTP | `test:api:external` | Requires an explicitly started local API; not a CI gate yet |

## Findings Fixed By This Audit

1. Postgres cache keys omitted nested parameters, allowing collisions.
2. High-confidence answers mapped to `insufficient` and were not persisted.
3. Tests could inherit a Supabase URL from `.env`; DB commands now force a
   localhost-only disposable database.
4. `it.skipIf(!dbAvailable)` was evaluated before `beforeAll`, silently
   skipping database tests. Required DB commands set `REQUIRE_TEST_DATABASE`.
5. Shared fixtures omitted `qualifying_results`, `season_driver_standing`, and
   current `race_data` fields.
6. Shared fixtures used IDs incompatible with current F1DB/lap normalization.
7. Teammate validation failed across hyphen/underscore ID forms.
8. Teammate public templates read unsuffixed tables while ETLs wrote `_2025`
   tables.
9. Npm glob patterns meant the original golden and integration commands ran
   zero tests.
10. Matchup lookup read an unsuffixed table while matchup ingestion writes
    `driver_matchup_matrix_2025`.
11. Jolpica standings are now covered end to end: deterministic upstream
    payload -> standings sync -> public season-summary points.
12. Jolpica race results are now covered end to end: deterministic upstream
    payload -> result sync -> public race-results template.
13. Matchup sync now honors its explicit season argument instead of silently
    writing every invocation into the module-default season.
14. Cache keys now include recursively normalized nested filters, preventing
    result collisions between scoped queries.

## Known Remaining Gaps

1. **External HTTP tests:** legacy `test:api:external` still skips unless a
   separately deployed/local server is available. Core HTTP behavior now has
   an in-process CI harness; retain external tests for smoke testing only.
2. **External fact evidence:** full Jolpica driver standings snapshots for
   2018–2025 are verified through the real sync path, covering more than 100
   driver-season position/points facts. Remaining incident cases for status
   semantics and pagination stay provisional until backed by immutable upstream
   result snapshots or reviewed source references.
3. **Complexity/size warnings:** lint now has zero errors and is a CI gate,
   but 116 warnings remain. Treat warning reduction as tracked refactoring
   work; do not weaken the rules.
4. **Test schema provenance:** run `npm run schema:snapshot:production` with
   production credentials intentionally configured to refresh the committed
   read-only `information_schema` snapshot. Compare it before changing the
   canonical test bootstrap.

## Current Verified Baseline

On the disposable PostgreSQL 16 environment:

- `test:unit:db:docker`: 30 files, 556 tests, 0 skipped, 0 failed.
- `test:golden:db`: 8 files, 26 tests, 0 skipped, 0 failed.
- `test:integration:db`: 5 files, 86 tests, 0 skipped, 0 failed.
- `test:schema:db`: 27 approved SQL templates prepare successfully and
  canonical test columns are a subset of the captured production
  `information_schema` snapshot.
- `test:api:inprocess`: 3 HTTP route tests pass against an ephemeral server.

## Rule

No suite may silently skip because a required dependency is missing. Either:

- it belongs to a required command and fails closed, or
- it is explicitly classified as an external/manual test and excluded from
  release coverage.
