# Production Database Authority Audit

`npm run audit:database-authority:production` is a bounded, evidence-only audit.
It is intentionally not an assertion that every production fact has been verified.
Record each invocation and its retained artifact in
`docs/PRODUCTION_EVIDENCE_LEDGER.md`.

## Safety

The runner requires both `DATABASE_AUTHORITY_AUDIT_ENABLED=true` and
`DATABASE_AUTHORITY_AUDIT_TARGET=production`, refuses loopback hosts, opens one
connection (`max: 1`), executes `BEGIN READ ONLY`, sets a 5000 ms transaction-local
statement timeout, issues only fixed `SELECT`/`WITH` statements, and rolls back.
It creates no files, tables, logs, or database state. It emits one JSON report.

Run from the production service only:

```sh
railway run --no-local --service main --environment production env DATABASE_AUTHORITY_AUDIT_ENABLED=true DATABASE_AUTHORITY_AUDIT_TARGET=production npm run --silent audit:database-authority:production
```

## Scope

The report inventories calendar/races, race classification, driver standings,
qualifying, pace, identities (distinct driver/team IDs from race classification), and the local scoring-rule registry. For each database
domain it reports observed season coverage counts, or a missing-relation ledger item.
It executes the fixed 23-case factual manifest, bounded below 32 checks, against
FIA/Formula 1 cited facts. The manifest samples historical and transition cases:
1950 metadata, 2014 double-points, 2019 fastest-lap points, 2021 reduced-race
classification, 2022 scoring, 2024 metadata/classification, and 2025 standings,
race, and qualifying facts.

## Authority And Limits

Source discovery is constrained to FIA and Formula 1. FIA final classifications,
championship-points documents, archives, and sporting regulations are primary
authorities; Formula 1 results/archive pages are official supplementary authorities.
Exact sources are in `scripts/f1ql-production-corpus-manifest.ts` and
`docs/F1QL_CORPUS_SOURCE_EVIDENCE.md`.

Pace rows are coverage observations only. They are not an official clean-air,
pit, in-lap, or out-lap validation. The separately retained 2026 Formula 1 timing
artifacts define the narrower raw-lap validation boundary. The scoring registry is
not used to recalculate season totals; FIA championship points and recorded standings
remain the authority for those totals. Missing data, a missing relation, and a factual
mismatch remain ledger entries and are never inferred or repaired.
