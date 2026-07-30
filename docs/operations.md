# F1Muse Operations

## Safety Boundary

- Never run database-backed tests with bare `vitest`; production credentials
  may exist in `.env`. Use the wrapped npm scripts.
- All F1QL answer access is read-only and statement-timeout bounded.
- `POST /program/translate` is shadow-only and must never execute.
- Do not deploy from an uncommitted or failing tree.
- Do not run production schema, evidence, pace, or audit commands casually;
  each has explicit guards and its own operational procedure.

## Answer Route Configuration

Both `POST /nl-query` and `POST /program/answer` are unavailable unless:

1. `F1QL_ANSWER_ENABLED=true`.
2. `F1QL_ANSWER_KILL_SWITCH` is not `true`.
3. The signed release attestation and all referenced evidence verify for the
   active commit/deployment and have not expired.
4. `F1QL_ANSWER_CANARY_STAGE` is nonzero, does not exceed the signed maximum,
   and admits both the subject and selected template.
5. `F1QL_ANSWER_DATABASE_URL` and
   `F1QL_ANSWER_DATABASE_CA_CERT_BASE64` configure the dedicated read-only
   answer database.
6. Runtime values match the signed release.
7. The route's principal class is present in the release attestation's signed
   `allowed_principal_classes`.

Public `POST /nl-query` additionally requires
`F1QL_PUBLIC_ANSWER_ENABLED=true`. Keep this independent gate false during
stage-zero verification and internal canaries so public traffic cannot enter an
execution cohort.

The offline release builder requires the explicit, sorted, unique
`F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES` allowlist. For stage-zero and the
authenticated stage-one canary, set it to `internal_canary`; do not include
`public`. Public rollout requires fresh evidence and a separately built,
independently verified attestation whose allowlist explicitly includes
`public`, followed by enabling `F1QL_PUBLIC_ANSWER_ENABLED`. An internal-only
attestation cannot issue a public execution authorization.

The kill switch is rechecked during execution. Set it to `true` to stop answer
execution without enabling another natural-language path.

`POST /program/answer` additionally requires
`Authorization: Bearer <F1QL_ANSWER_INTERNAL_TOKEN>`. The public
`POST /nl-query` route does not use this token.

## Runtime Bounds

Defaults from the active runtime contract:

| Setting | Default |
|---|---:|
| `F1QL_ANSWER_MAX_CONCURRENCY` | 2 |
| `F1QL_ANSWER_QUEUE_TIMEOUT_MS` | 2000 |
| `F1QL_ANSWER_REQUEST_TIMEOUT_MS` | 12000 |
| `F1QL_ANSWER_RATE_LIMIT_MAX` | 10 |
| `F1QL_ANSWER_RATE_LIMIT_WINDOW_MS` | 900000 |
| `F1QL_ANSWER_STATEMENT_TIMEOUT_MS` | 3000 |
| `F1QL_ANSWER_MAX_WORK_UNITS` | 2280 |
| `F1QL_ANSWER_MAX_ROWS` | 100 |
| `F1QL_ANSWER_MAX_RESPONSE_BYTES` | 65536 |

Configuration parsing enforces lower and upper bounds. Statement timeout may
not exceed request timeout. The signed release binds the effective values.

Redis provides distributed production rate limiting. Its absence must be
treated as degraded protection, not as permission to add answer/intent caches.

## Route Checks

```bash
curl http://localhost:3000/health
curl http://localhost:3000/health/db
curl http://localhost:3000/metrics
```

The root discovery response advertises F1QL program routes only when
`F1QL_ENABLED=true`. It advertises the internal answer route when the shared
answer gate is enabled and not kill-switched, and advertises `/nl-query` only
when the independent public gate is also enabled. `/health` reports separate
non-secret `answer_surfaces.internal` and `answer_surfaces.public` states.

Retained API routes:

```text
POST /nl-query
POST /program/answer
POST /program/translate
POST /program
GET  /program/verified
POST /program/verified/:id
GET  /share/:id
GET  /share-feed
GET  /driver/:driver_id/profile
GET  /driver/:driver_id/trend
```

`/query`, `POST /share`, suggestions, capabilities, and natural-language cache
diagnostics are not mounted.

## Testing

```bash
# Fast static checks
npm run typecheck
npm run lint

# Wrapped database suites; run sequentially because they share Docker state
npm run test:unit:db:docker
npm run test:integration:db
npm run test:f1ql
npm run test:api:inprocess
npm run test:golden:db
npm run test:schema:db

# Complete current package gate
npm run validate:full
```

`npm test` runs only the non-F1QL unit selection. It is not the complete gate.
Database-backed suites deliberately fail if their disposable PostgreSQL
dependency is unavailable.

The permanent shadow non-execution invariant, answer release/canary gates,
least-privilege execution, launch capability corpus, SQL/reference
differentials, and immutable-share behavior are covered by the wrapped suites.

## Schema Snapshot Caveat

`tests/schema/snapshots/production-schema.json` is a historical read-only
capture. It includes `laps_normalized_v2` with its 18 columns and
session-inclusive key, but predates the later pace-v2 replacement and rebuild
relations and their immutable triggers. Therefore it does not match the full
current production pace-v2 schema and is not the authority for current
serving/audit readiness. The retained fresh pace-v2 preflight evidence is the
current authority for those relations and triggers.

Refresh the snapshot only through the guarded command with intentionally
configured production credentials:

```bash
npm run schema:snapshot:production
```

The command is read-only, queries `information_schema`, uses a transaction-local
statement timeout, and rolls back. Refreshing it is an evidence operation, not
a routine local test and not a schema migration.

## Data Sync Boundary

Routine Jolpica sync refreshes current-season results and transactionally
replaces current-season standings. It may update latest-recorded 2026 answers
but cannot promote 2026 to a final-season capability. Such promotion requires
new versioned question, intent, template, policy, corpus, fixture, release, and
evidence contracts.

Routine Jolpica/results auto-sync is write-capable and disabled by default. Set
`AUTO_SYNC=true` to schedule the Monday 00:00 UTC cycle. A deployment does not
run catch-up work on startup unless `AUTO_SYNC_STARTUP_CATCH_UP=true` is also
set explicitly. The manual authenticated `POST /admin/sync` route remains
independent of these scheduler flags.

FastF1 lap ingestion is outside routine auto-sync. Pace-v2 writes require an
explicit reviewed manifest and the dedicated guarded commands documented by
the pace evidence procedures. Pace remains unauthorized for public Phase 10
answers.

## Immutable Shares

`GET /share/:id` reads the stored answer and may increment only its view count;
it never recomputes the answer. `GET /share-feed` reads recent/trending stored
shares. There is no API share-creation operation after Phase 10 cutover.
