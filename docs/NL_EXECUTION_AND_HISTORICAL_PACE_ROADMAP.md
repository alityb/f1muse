# NL Execution And Historical Pace Roadmap

This proposal follows the completed Phase 6 F1QL compiler, verified-program
library, and fact-space registry work. It does not change the invariant that
`POST /program/translate` is shadow-only and never executes a translated query.

## Goal

Answer natural-language F1 analytics questions through a constrained pipeline:

```text
Question
-> intent and schema linking
-> typed F1QL program
-> deterministic validation
-> parameterized read-only execution
-> answer with source, coverage, and limitation metadata
```

The model selects a typed F1QL intent. It never writes or executes arbitrary
SQL. Existing F1QL validation, compiler, row limits, statement timeout, and
read-only transaction remain the execution boundary.

## Phase 7: Gated NL Answers

Add a separate `POST /program/answer` endpoint. Do not change or reuse the
shadow route as an execution route.

### Validated Codebase Fit

The deterministic execution path is ready to reuse. `executeF1QL` reparses the
program, validates the surface and core IR, enforces cost and participation
rules, lowers and compiles deterministically, and executes parameterized SQL in
a read-only transaction with a statement timeout. The new endpoint must call
this function rather than creating a second compiler or executor.

The natural-language boundary needs additional work before execution can be
enabled:

- `program-translate.ts` resolves only pace drivers and race-classification
  driver filters. Standings and qualifying driver filters need canonical
  linking.
- No season-aware event-name resolver currently maps "Belgium 2021" to exactly
  one round.
- No reviewed team resolver exists. Team-filtered NL questions remain disabled
  for the first release.
- The translator's requested `unsupported` node is not valid F1QL. Translation
  needs a typed result union for candidate programs, clarification, unsupported
  requests, and provider failure.
- Generic aggregate/rank composition exists only for standings in the surface
  grammar. Race and qualifying are fixed retrieval macros, not arbitrary
  aggregation or comparison languages.
- The response row cap is currently checked after PostgreSQL returns rows. Phase
  7 must also bound work and response bytes before production enablement.
- Repository code establishes read-only transactions but does not prove that the
  production database role has only `USAGE` on `f1ql` and `SELECT` on approved
  views.

### Initial Capability Policy

The allowlist applies to semantic capability tuples, not exact sentences.

Allow:

- Final driver standings for one scalar season.
- Standings filters for a bounded set of canonically resolved drivers.
- Standings aggregation/ranking already representable by F1QL v1.
- Race classification for one season and round, optionally filtered by one
  resolved driver or classification status.
- Qualifying classification for one season and round, optionally filtered by one
  resolved driver or classification status.
- Race-date event metadata for one season and round.

Disable initially:

- Pace operations.
- Sprint, grid, constructor, and interim-standing questions.
- Team filters until a reviewed season-aware team resolver exists.
- Multi-season or unscoped standings requests.
- Arbitrary race/qualifying aggregation or comparison not expressible in the
  surface grammar.
- Ambiguous metric, session, event, temporal scope, or identity.

The first release should answer questions such as:

- "Who scored more points in 2024, Leclerc or Sainz?"
- "Show all classified drivers in the 2021 Belgian Grand Prix."
- "Where did Piastri qualify in round 6 of 2025?"

Each response must return the resolved F1QL program, source/fact-space version,
coverage, and caveats. Ambiguous requests must ask a focused clarification
rather than infer a metric or scope.

### Runtime Pipeline

```text
independent answer feature gate and kill switch
-> request size/rate/concurrency limits
-> bounded model translation
-> typed clarification/unsupported handling
-> deterministic entity and event linking
-> canonical program reparse
-> Phase 7 capability policy
-> executeF1QL (all existing gates rerun)
-> request-local completeness checks
-> deterministic answer formatting
-> source/version/coverage/caveat metadata
```

The answer route must not import or call `createProgramTranslateRoutes`. The
shadow route must retain its injected throwing-executor regression.

### Deterministic F1 Semantics

Permitted defaults:

- A named Grand Prix result, winner, or classification means the race unless a
  sprint is explicit.
- "2024 standings" means final season standings and must be labeled final.
- Higher points are better; lower race or qualifying position is better.
- "Won the championship" means final championship position 1, not reconstructed
  race-point totals.
- "Took pole" means qualifying-classification position 1, not starting-grid P1.

Never default:

- A missing season.
- Bare "better" to points, position, qualifying, or pace.
- "Weekend" to race when a sprint distinction matters.
- Interim standings to final standings.
- Missing or null points to zero.
- A starting-grid request to qualifying classification.
- "Faster" to race winner or classification position.

Clarification responses should identify one disputed slot and offer only
supported choices. Stable reason codes should include `metric_ambiguous`,
`session_ambiguous`, `season_missing`, `event_ambiguous`, `entity_ambiguous`,
`temporal_scope_unsupported`, `sprint_source_unsupported`,
`grid_source_unsupported`, `constructor_source_unsupported`,
`pace_source_disabled`, and `source_coverage_missing`.

### Answer Contract

A successful response should include:

```json
{
  "mode": "gated_execution",
  "program": {},
  "program_hash": "sha256",
  "answer": { "headline": "...", "facts": [] },
  "rows": [],
  "rendering": "...",
  "metadata": {
    "source": "standings",
    "definitions_version": "v2",
    "compiler_version": "core-v1",
    "fact_space_version": "source-views-v1",
    "coverage": { "status": "sufficient", "rows_returned": 2 },
    "caveats": []
  }
}
```

The answer formatter must be deterministic. Empty rows mean unavailable or no
matching source row, not factual zero. It must preserve nulls, ties, missing
comparison sides, numeric-string conversions, and classification limits. An LLM
must not add facts or causal explanations after execution.

### Work Packages

1. Define a typed translation result: `program_candidate`,
   `clarification_required`, `unsupported`, or `provider_unavailable`.
2. Implement season-aware driver and event linking with ambiguity surfaced as
   candidates, not silently resolved.
3. Add the answer-specific capability policy and bounded timeout/collection
   configuration.
4. Add an independent `F1QL_ANSWER_ENABLED` gate, emergency kill switch,
   answer-specific rate limiter, and bounded model/database concurrency.
5. Add deterministic source-specific answer formatting and runtime
   source-contract metadata.
6. Add an execution authorization envelope containing the approved capability,
   active versions, request identity, and authenticated principal class.
7. Prove a least-privilege database role with only the required schema/view
   privileges; revoke temporary-table and unsafe schema privileges.
8. Move output bounds into compiled execution, add response-byte limits, validate
   timeout values, and cancel work when the request disconnects.
9. Add low-cardinality metrics for translation, resolution, clarification,
   policy, execution, coverage, and total latency without logging questions or
   result rows by default.

### Evaluation Plan

Treat the endpoint as a selective system with three actions: answer, clarify, or
abstain. Maintain separate development, IID holdout, temporal/entity holdout,
and adversarial sets. Each reviewed example should record answerability, all
defensible interpretations, canonical entities, expected action, canonical
programs, expected fixture results, and ambiguity/risk tags.

Report together:

- Normalized AST exact match for canonical F1QL.
- Component accuracy for source, scope, entities, filters, operation, ordering,
  and limits.
- Fixture execution and test-suite accuracy over distinguishing database cases.
- Entity/event candidate recall and complete canonical-link accuracy.
- Ambiguity detection, false-clarification rate, post-clarification accuracy,
  unsafe-answer rate, and false-abstention rate.
- Risk-coverage and calibration results, not model verbal confidence.
- Metamorphic consistency under paraphrases, aliases, filter reordering, schema
  distractors, result-preserving database changes, and valid limit/sort laws.
- Clean/adversarial accuracy and worst-group performance for prompt injection,
  capability escalation, typos, alias collisions, nulls, ties, empty results,
  oversized requests, and unsupported operations.

Hard release gates:

- 100% rejection of forbidden operations and unauthorized capability tuples.
- The shadow throwing-executor invariant remains green.
- No execution before all answer-route gates pass; exactly one guarded execution
  after approval.
- No regression in the wrapped F1QL, API, golden, property, metamorphic, or
  differential suites.
- Per-source and per-operation semantic thresholds pass with reviewed holdout
  evidence; aggregate translation success is insufficient.
- Unsafe-answer, clarification, timeout, result-size, and latency budgets pass.
- Production least-privilege grants are retained as evidence.

### Release Sequence

1. Keep execution disabled by default and collect shadow evaluation evidence
   from a broad question corpus.
2. Run offline semantic, ambiguity, grounding, adversarial, and factual-source
   gates. Do not execute translated programs during shadow evaluation.
3. Enable reviewed capability tuples for internal users through an independent
   feature flag.
4. Canary by stable user/session cohort at 1%, 5%, 25%, 50%, then 100%, with a
   simultaneous control and automatic rollback on safety or SLO failures.
5. Expand by source/operator tuple, never through one global execution switch.
6. Use verified programs as exact trusted anchors or fallbacks, never as fuzzy
   substitutes for semantically different questions.

## Phase 8: Historical Lap Pace

Questions such as "who was faster between laps 3-10 in Belgium 2022, Verstappen
or Alonso?" need additional product and evidence support:

- Event-name resolution to canonical season/round/event identity.
- `lap_start` and `lap_end` scope, distinct from championship round scope.
- An explicit "faster" metric. The initial recommendation is median valid raw
  lap time over the requested lap window.
- Defined treatment of deleted, invalid, pit, in-lap, out-lap, safety-car, and
  weather-affected laps.
- Per-event historical lap ingestion, identity mapping, and provenance checks.

Initial historical pace output should be factual only for raw per-lap timing
records whose official artifact, driver identity, and lap mapping are retained
and validated. It must not claim clean-air filtered pace truth until an authority
supplies equivalent per-lap clean-air, validity, pit, in-lap, and out-lap
semantics.

## Evidence Findings

The FIA's 2022 Belgian Grand Prix event/timing archive provides official race
lap charts, deleted-lap records, and fastest-lap documents. The official fastest
lap document establishes individual best laps but not every driver's laps 3-10.

The hash-pinned Phase 8 pilot uses the FIA Race History Chart, final race
classification, and deleted race lap-time decision. The parser treats an
`N LAP(S)` history-chart gap as a completed-lap offset rather than a numeric
gap. It reconciles all 790 classification-implied completed-lap keys in both
directions, maps all five deleted times uniquely by racing number and printed
time, and retains all 790 printed completed-lap rows. A separate hash-bound map
covers all 20 official identities, including a reviewed canonical-name-order
bridge. The 16 rows for cars 1 and 14 over laps 3-10 remain a derived subset.

The first named metric contract is
`official_non_deleted_non_pit_window_median_v1`: for exactly two reviewed
drivers and one inclusive race-lap window, require every requested official lap
identity, exclude only FIA-deleted times and rows explicitly marked `PIT`,
require at least two remaining laps per driver, take each driver's median, and
define the lower median as faster. Safety-car, weather, traffic, tyre, fuel, and
other race-state effects remain included and caveated because no equivalent
per-lap context contract is retained. A private, unapplied `official_timing`
migration and seal-last scope-serialized writer now prove persistent localhost
ingestion of all 790 facts with immutable artifacts, identities, and coverage.
This storage has no F1QL view, runtime role grant, operation, answer capability,
production application, or production ingestion authorization.

Formula 1 TimingData streams can support lap-level reconstruction. FastF1's
implementation documents that it derives lap, pit, and gap fields from mixed
timing streams and that some values need post-processing or educated assignment.
Use this only as an implementation aid: retain and validate the official timing
artifact before making raw-lap factual claims.

## Safety Model

- The model does not receive database credentials or arbitrary SQL access.
- Every executable program is parsed, validated, cost-limited, compiled to
  parameterized SQL, and executed in a read-only transaction with a statement
  timeout.
- Only documented F1QL sources and operators can execute.
- Unsupported source coverage or ambiguous terminology fails closed with a
  structured explanation.
- Production changes require their own approved migration and deployment path.
- The execution role must be a non-owner, non-superuser role with `USAGE` only
  on the `f1ql` schema and `SELECT` only on compiler-approved views. Read-only
  transactions are defense in depth, not a substitute for least privilege.
- Prompt-injection detection may add telemetry or conservative blocking, but the
  closed F1QL language and deterministic authorization gates remain the security
  boundary.
- SQL row limits do not necessarily limit scanned work; resource policy must also
  bound time, concurrency, response bytes, and reviewed query shapes.

## Research References

- [Oracle SQL Search (NL2SQL)](https://docs.oracle.com/en-us/iaas/Content/generative-ai/nl2sql.htm): separates SQL generation from execution and uses distinct enrichment and lower-privilege query connections.
- [Atlas SQL validation pipeline](https://docs.useatlas.dev/security/sql-validation/): describes layered SELECT-only, AST, allowlist, limit, timeout, and fail-closed controls.
- [dbt Semantic Layer architecture](https://docs.getdbt.com/docs/use-dbt-semantic-layer/sl-architecture): models metrics, entities, dimensions, and compiler-owned join paths as a governed semantic layer.
- [Snowflake Semantic Views](https://docs.snowflake.com/en/user-guide/views-semantic/overview): centralizes logical facts, dimensions, metrics, and relationships rather than exposing physical SQL generation choices.
- [Snowflake Verified Query Repository](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst/verified-query-repository): uses reviewed queries as trusted semantic anchors.
- [OWASP Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html): recommends least privilege, structured separation, tool validation, output validation, monitoring, and kill switches.
- [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html) and [row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): database-level least-privilege controls.
- [Spider](https://aclanthology.org/D18-1425/), [test-suite accuracy](https://aclanthology.org/2020.emnlp-main.29/), and [Dr.Spider](https://arxiv.org/abs/2301.08881): semantic parsing, distinguishing-database evaluation, and adversarial robustness methods.
- [PRACTIQ](https://aclanthology.org/2025.naacl-long.13/) and [AMBROSIA](https://arxiv.org/abs/2406.19073): interactive clarification and ambiguity evaluation.
- [Google SRE canarying releases](https://sre.google/workbook/canarying-releases/): representative cohorts, simultaneous controls, staged rollout, and rollback.
- [FIA 2022 Belgian Grand Prix event and timing information](https://www.fia.com/events/fia-formula-one-world-championship/season-2022/belgian-grand-prix/eventtiming-information): official timing-document archive.
- [FIA 2022 Belgian Grand Prix race fastest laps](https://www.fia.com/sites/default/files/2022_14_bel_f1_r0_timing_racefastestlaps_v01.pdf): official fastest-lap record.
- [FIA 2022 Belgian Grand Prix race history chart](https://www.fia.com/sites/default/files/2022_14_bel_f1_r0_timing_racehistorychart_v01.pdf): printed completed-lap times, leader-relative gaps, lapped-car markers, and pit markers.
- [FIA 2022 Belgian Grand Prix final race classification](https://www.fia.com/sites/default/files/doc_71_-_2022_belgian_grand_prix_-_final_race_classification.pdf): official racing-number/name identity and completed-lap counts.
- [FIA 2022 Belgian Grand Prix deleted race lap times](https://www.fia.com/sites/default/files/doc_68_-_2022_belgian_grand_prix_-_race_deleted_lap_times.pdf): five official disallowed times used only through unique number/time joins.
- [FastF1 timing API implementation](https://github.com/theOehrly/Fast-F1/blob/master/fastf1/_api.py): implementation notes on reconstructing lap and stream timing data.
