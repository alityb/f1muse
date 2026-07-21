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
| Authoritative factual | 0 in the fixture corpus | Separate FIA-backed manifest cases |

The local corpus is synthetic 2025 data, so its result rows are not facts about
production. All pace cases are fixture-only: FastF1 lap coverage is
source-dependent. The 15 deliberate malformed/rejected programs are also
fixture-only. The fixed manifest has three structural checks and two
FIA-backed Bahrain 2024 factual checks, well below its six-program bound.

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

- Historical scoring eras, shared-drive points, or dropped-score boundaries.
- The 2014 double-points season-final exception.
- Fastest-lap boundaries: 2019-2024 bonus versus its 2025 removal.
- Sprint transitions: 2021 top-three trial and 2022 onward top-eight schedule.
- Null finishing/qualifying positions, status normalization, and DNS/DNF/DSQ
  source variation.
- Driver identity aliases across F1DB, Jolpica, and FastF1 identifiers.
- Historical qualifying and lap-pace data coverage.

These are represented by the scoring registry and local fixtures where
applicable, but each needs an event-specific authoritative production case
before being promoted to factual verification.
