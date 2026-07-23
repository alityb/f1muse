# Production Database Lifecycle Audit

`npm run audit:database-lifecycle:production` is a bounded, read-only database
lifecycle observation. Retain its one-line JSON output in
`docs/PRODUCTION_EVIDENCE_LEDGER.md`; it never writes an audit record to production.

## Safety

The runner requires `DATABASE_LIFECYCLE_AUDIT_ENABLED=true` and
`DATABASE_LIFECYCLE_AUDIT_TARGET=production`, rejects loopback targets, uses one
connection, runs `BEGIN READ ONLY`, sets a transaction-local 5000 ms timeout, uses
fixed catalog/read queries, and rolls back. It does not run translated F1QL programs.

```sh
railway run --no-local --service main --environment production env DATABASE_LIFECYCLE_AUDIT_ENABLED=true DATABASE_LIFECYCLE_AUDIT_TARGET=production npm run --silent audit:database-lifecycle:production
```

## Report

The report inventories committed migration filenames and recognizes only explicit
public migration-ledger relation names (`schema_migrations`, `migrations`, or
`knex_migrations`). It does not infer applied history from an unknown table shape.
It reconciles the expected legacy, v2, correction-audit, and serving-view relations;
reports table/index bytes; lists database catalog dependents on legacy
`laps_normalized`; reports the deployed `f1ql.lap_pace` definition and its catalog
dependencies; and counts active served rows by the documented precedence:
`fastf1_complete_race_v1`, `nat_pit_flags_v1`, then `laps_normalized_v2`.

Database catalog dependencies do not include dynamic SQL or application callers.
The audit observes selection and schema state only; it neither validates correction
facts nor repairs, migrates, or writes database state.
