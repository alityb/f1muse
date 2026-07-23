# F1QL Performance Evidence

`npm run evidence:f1ql:performance:production` is a bounded production
observation runner. It is not a load test, a release gate, or a data-correctness
validator.

It refuses to start unless both settings are present:

```sh
F1QL_PERFORMANCE_EVIDENCE_ENABLED=true
F1QL_PERFORMANCE_EVIDENCE_TARGET=production
```

It also requires a valid non-loopback `DATABASE_URL`. The scheduled workflow
supplies this only through Railway's protected `production` environment with
`--no-local`; developers must not run it against production without that
authorization.

The runner opens one connection, issues `BEGIN READ ONLY`, sets a transaction-
local five-second statement timeout, and always rolls back. It compiles fixed
representative F1QL programs for standings, race classification, qualifying
classification, event metadata, and lap pace. For each source it emits a SHA-256
query fingerprint, a sanitized `EXPLAIN (FORMAT JSON)` structural summary, and
two warmups followed by seven measured executions with p50/p95 wall-clock time.
It emits no SQL text, parameters, result values, URLs, or credentials.

Lap pace additionally observes the serving `f1ql.lap_pace` view and the
available `nat_pit_flags_v1`, `fastf1_complete_race_v1`, and original-v2
relations separately. A missing correction relation is reported as `attention`;
it is not created, inferred, or replaced. These layer observations describe
query shape and bounded timing only and do not validate pace eligibility or
external factual correctness.

The protected nightly workflow sanitizes the JSON report and uploads it with the
commit and UTC metadata. Retain any material authorized production result in
`docs/PRODUCTION_EVIDENCE_LEDGER.md` with its command, capture time, and hash.
