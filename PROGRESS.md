# Progress

## Autonomous Roadmap Progress

### Phase 0: COMPLETE
- Translation entry: `src/api/routes/program-translate.ts` is feature-gated, shadow-only, and does not call `executeF1QL`.
- Translation adapters: `src/f1ql/translator.ts` supports Anthropic and OpenAI-compatible tool calls; production uses Groq.
- Surface schema/lowering: `src/f1ql/ast.ts`, `schema.ts`, `lower.ts`.
- Core/compiler/interpreters: `src/f1ql/core.ts`, `compiler.ts`, `interpreter.ts`, `executor.ts`.
- Existing budgets: `src/f1ql/limits.ts`; API route handles program metrics/logging.
- Tests: `tests/f1ql/*`, `tests/api/in-process-routes.test.ts`; local PostgreSQL is bootstrapped by `src/test/setup.ts`.
- CI: `.github/workflows/test.yml` runs typecheck, lint, unit, golden, integration, schema, and in-process API gates.
- Property testing: no library is installed. `fast-check` is the appropriate TypeScript dependency for Phase 5, but will be introduced only with bounded generators.

### Phase Status
- Phase 1: COMPLETE. The Railway historical-log fetch was proven during Phase 2.
- Phase 2: COMPLETE. All six validation gates, local definition-of-done suites, typed observability flow, and the production shadow round-trip are verified.
- Phase 3: PARTIAL. Current core IR still has specialized pace and classification nodes. Preserve behavior before refactoring.
- Phase 4: PARTIAL. Standings, pace, and race classification exist; qualifying/event metadata/retirement sampling remain incomplete.
- Phase 5: PARTIAL. Targeted goldens and differential tests exist; 100-question corpus, property, metamorphic, and nightly suites do not.

### Phase 1 Metrics Fixture
- Local shadow route test observed: succeeded=1, invalid=2, unavailable=1, identity_miss=1, unsupported=1.
- PARTIAL: `railway status --json` reports the production service plan as `hobby`. Retention is not exposed by the CLI and must be verified in Railway plan documentation/dashboard before asserting a window. The report uses timestamps actually returned by Railway. To complete 30-day review, configure a durable log export if the verified retention is under 30 days.
- Decision: `tests/fixtures/f1ql-shadow.log` is force-added because `*.log` is globally ignored for runtime logs; this fixture is a deterministic parser contract, not an operational log.

### Phase 1 Production Shadow Review (2026-07-19)
```text
# F1QL Shadow Translation Review
- Window: no retained events
- Attempts: 0
- Success rate: 0.00%
- Readiness: Keep shadow-only; insufficient volume or success rate.
```
- A known-driver production request returned a canonical `pace_summary` in shadow mode after the timestamped logging deployment.
- Expected caveat: legacy pre-timestamp log lines would appear as `unknown` if returned by Railway; none were returned by the headless fetch.
- PARTIAL: Railway CLI returned no structured retained events for `--since 30d`. Validate project log-retention/export configuration before relying on the automated 30-day report.
- PARTIAL: `npm run test:f1ql` could not start because the local Docker daemon was unavailable. Start Docker and rerun `npm run test:f1ql`; database-backed Phase 1 tests were green before this environment outage.

### Phase 2 Validation Pipeline (2026-07-21)
- Delivered all gates: participation checks against `season_entrant_driver`; coverage/signature enforcement against `F1QL_SIGNATURES`; configurable AST node budget; active definitions-version refresh input; and a configurable transaction-local read-only statement timeout.
- Rejections are typed through validation, shadow-route log reason, Prometheus/JSON metrics reason label, and report parser: `participation_missing`, `complexity_exceeded`, `coverage_unsupported`, `definitions_version_mismatch`, and `signature_invalid`.
- Docker-backed proof: `npm run test:f1ql` passed 39 tests, including a `pg_sleep` query cancelled by a 10ms configured timeout. `npm run test:api:inprocess` passed 7 tests after adding phase-required 2030 entrant fixtures. `npm run typecheck` passed; lint passed with 0 errors and 117 pre-existing warnings.
- Railway observability loop proven. `railway status --json` confirmed service `main`, environment `production`, Logs V2. `railway logs --service main --environment production --since 30d --json` returned historical runtime JSONL, not build/deploy-only output; each event has the documented top-level `timestamp`, `message`, and `level` envelope. A real production `POST /program/translate` returned a shadow `pace_summary`; fetching `--since 5m` contained `[F1QLTranslation]` in `message`; `npm run report:f1ql-shadow -- /var/folders/p9/gh5frnt56_l4t03p8dl_fq3m0000gn/T/opencode/railway-production-5m.jsonl` reported one attempt, 100.00% success, `validated_shadow_program: 1`, `pace_summary: 1`.
- Fix: set Express `trust proxy` to exactly `1` hop for Railway, restoring per-client rate-limit keys and eliminating `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`; successful translation reasons are excluded from report rejection ranking.
- Decision: Railway logs are deployment-scoped. The automated 30-day review therefore covers only the window since the latest deployment, not a cross-deployment rolling period. The durable-sink decision remains deferred and must not be implemented without explicit instruction.
- PARTIAL production release: dead deployment `ebc4a0e0-74cf-4ec9-8a53-76633334f320` was superseded once by `43b9103e-d953-4e09-b946-bc9ddb7fec97` after a committed green state. The replacement stayed `BUILDING` with `deploymentStopped: true` on every 30-second poll for five minutes. `railway logs 43b9103e-d953-4e09-b946-bc9ddb7fec97 --deployment --lines 100` returned no deploy logs. Investigate the stopped deployment in Railway before a single new deploy attempt; do not retry blindly.
- Production completion: the existing replacement deployment later advanced to `DEPLOYING` and then `SUCCESS`; no additional deploy was created. A known-driver `POST /program/translate` returned a shadow `pace_summary`. After 15 seconds, `railway logs --service main --environment production --since 5m --json` was fetched and reported as follows:
```text
# F1QL Shadow Translation Review

- Window: 2026-07-21T06:32:58.161Z to 2026-07-21T06:32:58.161Z
- Attempts: 1
- Success rate: 100.00%

## Outcomes
- succeeded: 1

## Rejection reasons

## Operations
- pace_summary: 1

## Readiness
- Keep shadow-only; insufficient volume or success rate.
```

### Phase 0-2 Confidence Audit (2026-07-21)
- Static audit identified two correctness gaps despite the prior green suites: participation validation omitted driver-filtered standings and event-classification programs; `/program` converted typed validation failures into generic execution failures.
- Fix: participation now derives every currently scoped driver/season pair, including standings filters and event-classification filters. `/program` now returns a typed 400 rejection code and logs the validation code. Railway report parsing now ignores non-string external `message` envelopes rather than throwing.
- New Docker-backed regressions cover driver-filtered standings participation, event-classification participation, environment-backed definitions refresh, and HTTP typed participation rejection. The metric expectation was expanded to account for that new rejection.
- Verification after the audit: `npm run typecheck` passed; `npm run lint` passed with 0 errors and 117 existing warnings; `npm run test:f1ql` passed 41 tests; `npm run test:api:inprocess` passed 7 tests; `npm run test:unit:db:docker` passed 598 tests in 36 files.
- Production confidence round-trip: deployment `0e242331-c5e6-4163-823d-1f7419ff38b6` reached `SUCCESS`. A known-driver shadow request returned `pace_summary`; after 15 seconds, the Railway JSONL report showed one attempt, 100.00% success, no rejection reasons, and operation `pace_summary`.

### Phase 3 Core IR Refactor (2026-07-21)
- Checkpoint complete: `scripts/snapshot-f1ql-lowering.ts` generates `tests/fixtures/f1ql-lowering-golden.json` from the real `parseF1QLProgram` and `lowerF1QL` emitter; `tests/f1ql/lowering-golden.test.ts` compares every schema-valid shadow-corpus program exactly. The generated snapshot covers standings aggregate, pace summary, pace delta, event classification, and the schema-valid unknown-identity program.
- Next: replace bespoke core `pace_aggregate`, `subtract`, `event_classification`, and fused `sort_limit` nodes with generic Source, Filter, Aggregate, Sort, Limit, Join, Compare, and Delta nodes. Update compiler/interpreter and preserve snapshot output only where surface semantics remain intentionally unchanged; document any intentional snapshot diff before accepting it.
- Completed first compositional change: fused `sort_limit` is now `limit → sort → aggregate`. The lowering golden was regenerated from the real emitter; this is an intentional internal snapshot shape change with identical compiled SQL, interpreter rows, and API results. `typecheck`, lint (0 errors), 42 F1QL tests, and 7 in-process API tests passed.
- Completed core source boundary: standings lowering now emits a core-owned `source` node rather than reusing the surface AST type. The snapshot JSON and all 42 F1QL tests remain unchanged. Next is to generalize the source/filter types for pace and classification before replacing their bespoke compiler/interpreter paths.
- Completed bounded classification milestone: the `event_classification` surface macro now lowers to core `source(event_classification) -> filter -> sort(finishing_position asc, nulls last) -> limit`; `CoreEventClassificationNode` and its opcode dispatch were removed. Compiler and reference interpreter consume the generic chain while preserving exact predicates, parameter ordering, selected columns, ordering, and limits. The lowering golden was regenerated from the real emitter; its classification entry intentionally changed shape only. Pace nodes were not refactored.
- Verification: `npm run typecheck` passed; `npm run lint` passed with 0 errors and 117 pre-existing warnings; `npm run test:f1ql` passed 42 tests; `npm run test:api:inprocess` passed 7 tests. The shadow translator remains non-executing; its injected-executor invariant remains covered by the F1QL suite.
- Completed pace lowering: `pace_summary` now emits `source(lap_pace) → filter(valid-lap eligibility) → aggregate(median by round) → aggregate(count/mean)`. `pace_delta` emits two equivalent per-round aggregates joined on `round`, then `compare → delta`. Removed `CorePaceAggregateNode`, `CoreSubtractNode`, and their compiler/interpreter opcode dispatch. The compiler retains the established SQL parameter order for summary and delta programs; reference interpretation retains shared-event and null behavior.
- Intentional regenerated-golden difference: pace summaries formerly serialized as `pace_aggregate`; pace deltas as `subtract` with two `pace_aggregate` children. They now serialize the explicit generic `source`, `filter`, `aggregate`, `join`, `compare`, and `delta` composition. Surface renderings, API rows, valid-lap exclusions, per-event median/cross-event mean, shared-event alignment, and shadow non-execution are unchanged.

## 2026-07-18: Shadow F1QL Translation
- Decision: `/program/translate` is independently feature-gated by `F1QL_TRANSLATION_ENABLED`.
- Decision: the initial route is shadow-only and returns a validated program without calling `executeF1QL`.
- Decision: driver identities use the strict database-backed `DriverResolver`; no humanized or guessed fallback IDs are allowed.
- Decision: translation accepts only the constrained F1QL schema. Legacy intents and SQL fallbacks are prohibited.
- Fix: Anthropic translation now uses forced tool use (`emit_f1ql_program`) instead of prompt-only text JSON after a production shadow request returned non-JSON text.
- Decision: use Groq `openai/gpt-oss-20b` through the OpenAI-compatible adapter for low-cost shadow translation.
