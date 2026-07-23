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

Initial enabled capabilities are composable, not a fixed list of questions:

- Sources: standings, race classification, qualifying classification, event
  metadata.
- Scope: supported seasons, rounds, canonical drivers, teams, and events.
- Operations: filter, aggregate, sort, limit, and supported comparisons.

The first release should answer questions such as:

- "Who scored more points in 2024, Leclerc or Sainz?"
- "Show all classified drivers in the 2021 Belgian Grand Prix."
- "Where did Piastri qualify in round 6 of 2025?"

Each response must return the resolved F1QL program, source/fact-space version,
coverage, and caveats. Ambiguous requests must ask a focused clarification
rather than infer a metric or scope.

Release sequence:

1. Keep execution disabled by default and collect shadow evaluation evidence
   from a broad question corpus.
2. Measure translation/validation outcomes by source and operation.
3. Enable only capabilities with reviewed translation accuracy and factual
   source contracts.
4. Use verified programs as trusted common-query fallbacks, not as the complete
   language.
5. Preserve the injected throwing-executor test for shadow translation.

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

## Research References

- [Oracle SQL Search (NL2SQL)](https://docs.oracle.com/en-us/iaas/Content/generative-ai/nl2sql.htm): separates SQL generation from execution and uses distinct enrichment and lower-privilege query connections.
- [Atlas SQL validation pipeline](https://docs.useatlas.dev/security/sql-validation/): describes layered SELECT-only, AST, allowlist, limit, timeout, and fail-closed controls.
- [FIA 2022 Belgian Grand Prix event and timing information](https://www.fia.com/events/fia-formula-one-world-championship/season-2022/belgian-grand-prix/eventtiming-information): official timing-document archive.
- [FIA 2022 Belgian Grand Prix race fastest laps](https://www.fia.com/sites/default/files/2022_14_bel_f1_r0_timing_racefastestlaps_v01.pdf): official fastest-lap record.
- [FastF1 timing API implementation](https://github.com/theOehrly/Fast-F1/blob/master/fastf1/_api.py): implementation notes on reconstructing lap and stream timing data.
