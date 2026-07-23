# F1QL Production Corpus

`npm run golden:f1ql:production` is a deliberately small production-read-only
projection of the 100-case local F1QL golden corpus. It does not translate
questions, invoke a model, or write data.

## Corpus Audit

The committed `productionCorpusAudit` classifies all 100 local cases:

| Class | Count | Runner action |
| --- | ---: | --- |
| Fixture-only | 41 | Explicitly skipped |
| Production-runnable structural | 59 | Audited; only the fixed manifest projection runs |
| Authoritative factual | 0 in the fixture corpus | Separate official-source manifest cases |

The local corpus is synthetic 2025 data, so its result rows are not facts about
production. All pace cases are fixture-only: FastF1 lap coverage is
source-dependent. The 15 deliberate malformed/rejected programs are also
fixture-only. The fixed manifest has three structural checks and 23
official-source factual checks, within its thirty-two-program bound. Nine
final-season championship-points checks read only the canonical season
standings authority (`f1ql.driver_standings`, backed by
`season_driver_standing`), never a sum of race points. The factual checks cover
the 1950, 2014, 2019, 2021, 2022, 2024, and 2025 scoring-rule
intervals and exercise standings, race classification, qualifying
classification, and event metadata. The 2025 projection includes final P2/P3
and zero-point standings, Australia race P2/P3/DNF,
Australia qualifying P2/P3, and Australia metadata. Every factual check carries a FIA or
Formula 1 URL in committed code; research and cost are in
`F1QL_CORPUS_SOURCE_EVIDENCE.md`.

## Guardrails

The command requires both `F1QL_PRODUCTION_GOLDEN_ENABLED=true` and
`F1QL_PRODUCTION_GOLDEN_TARGET=production`, rejects localhost and loopback
URLs, and requires `DATABASE_URL`. It opens one connection, starts one `BEGIN
READ ONLY` transaction, sets a transaction-local five-second timeout, checks
each canonical relation with `to_regclass`, and always rolls back.

Only compiled `SELECT`/`WITH` statements without write or DDL keywords may
run. A missing canonical view is reported as `skipped` with
`missing_production_view`, not treated as a factual pass. Standard output is
one JSON object for successful, failed, and refused invocations.

Run only from an authorized production environment:

```bash
F1QL_PRODUCTION_GOLDEN_ENABLED=true F1QL_PRODUCTION_GOLDEN_TARGET=production npm run golden:f1ql:production > /approved/evidence/f1ql-production-corpus.json
```

Do not run this against a local database. Retain the stdout evidence outside
the database. A `failed` factual case needs data/mapping investigation; do not
rewrite the expected fact without an updated authority.

## Coverage Gaps

The production projection intentionally does not claim factual proof for:

- Historical scoring eras beyond the one cited 1950 metadata case, including
  shared-drive points and dropped-score boundaries.
- Per-event coverage beyond the cited 2014 double-points, 2019 fastest-lap,
  2021 abbreviated-race, 2022 scoring-interval, 2024, and 2025 cases. The
  final-standing checks validate one champion total per selected season, not
  every driver or event.
- Sprint-session facts: 2021's top-three trial and 2022 onward top-eight
  schedules are represented in the scoring registry, but no sprint source is
  available to F1QL's race-only event-classification query.
- DNS and DSQ: FIA-authoritative 2025 Australia DNS and Las Vegas DSQ rows
  were absent from the canonical production view during the guarded run.
- Status normalization outside the cited 2025 Australia DNF, including
  historical source variation.
- Driver identity aliases across F1DB, Jolpica, and FastF1 identifiers.
- Historical qualifying and lap-pace data coverage.
- The 2026 Australian race eligibility-artifact set. Fresh 2026-07-23 UTC
  acquisition retained Formula 1 `TimingData` SHA-256
  `a2521be4b468f9ec4c61211558521c993269eb34c24c600e1fa3c90ebb251c8d`
  (5,607,988 bytes) and `DriverList` SHA-256
  `ee6c5096ab3c3f477eaf4856ed97cb9457bc0d109e26a90d4dd182df6ab57747`
  (16,531 bytes), plus FIA Race Lap Chart SHA-256
  `e09df9ec2dab4ab1c7ed9f8f913826c6bbe7cbd41d132ad472565c2979399270`,
  Pit Stop Summary SHA-256
  `b58492e23eb4f184a9c62444126a806241d81a192acee2081b7703f6a280ceb2`,
  and On Track Analysis SHA-256
  `6ac6c25a4826d7583c70750cfe5311f18928660ebd993f27c452c9098ca76f84`.
  The FIA PDFs establish position order, pit-stop lap, and pit entry/exit
  records, but no per-completed-lap validity decision or numeric car-ahead gap.
  `TimingData` has incremental live interval and pit-state updates, but no
  reviewed contract binding an interval sample to each completed lap or defining
  it as the F1QL/ FastF1 car-ahead gap. Therefore `clean_air_flag`,
  `is_valid_lap`, and the exact per-lap in/out classification remain
  unavailable, not inferred. A strict comparison of every F1QL eligibility
  inclusion/exclusion cannot complete and no pace production golden is
  permitted.

The factual projection does not prove source completeness: a missing view is a
skip, and a successful case proves only the cited event fields. It does not
derive season totals from race points, infer sprint-session results (the F1QL
event source is race-only), normalize historic identity aliases, or certify
lap-pace coverage.
