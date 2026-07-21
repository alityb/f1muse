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
fixture-only. The fixed manifest has three structural checks and ten
official-source factual checks, within its sixteen-program bound. The factual
checks cover the 1950, 2014, 2019, 2021, 2022, 2024, and 2025 scoring-rule
intervals and exercise standings, race classification, qualifying
classification, and event metadata. Every factual check carries a FIA or
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
  2021 abbreviated-race, 2022 scoring-interval, 2024, and 2025 cases.
- Sprint-session facts: 2021's top-three trial and 2022 onward top-eight
  schedules are represented in the scoring registry, but no sprint source is
  available to F1QL's race-only event-classification query.
- Null finishing/qualifying positions, status normalization, and DNS/DNF/DSQ
  source variation.
- Driver identity aliases across F1DB, Jolpica, and FastF1 identifiers.
- Historical qualifying and lap-pace data coverage.

The factual projection does not prove source completeness: a missing view is a
skip, and a successful case proves only the cited event fields. It does not
derive season totals from race points, infer sprint-session results (the F1QL
event source is race-only), normalize historic identity aliases, or certify
lap-pace coverage.
