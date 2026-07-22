# Worklog

## 2026-07-21 - Phase 4 Repair And Pace Artifact Protocol

- Added a separately invoked, flag-gated primary repair path for the existing v2 round-1 exact identity alias only. It requires a checksum-validated repair manifest containing source and target full-row fingerprints, row count, session, and methodology contract before the one permitted update.
- Added a forward-only immutable `pace_v2_identity_repair_audit` migration. The repair locks facts in a serializable transaction, validates source rows before mutation and target rows afterward, then records audit evidence atomically.
- Added a bounded selected-event pace artifact protocol. It is read-only, dual-flagged, capped at 30 driver medians, and declares database-observation scope rather than independent external truth without a retained authority artifact.
- No production query, migration, repair, ingestion, or deployment was run.

## 2026-07-21 - Phase 4 Manifest Safety Fixes

- Added exact, reviewed pace-v2 track reconciliation for `australian_grand_prix` to canonical `melbourne`; unlisted identities are unchanged and fail existing exact checks rather than being guessed.
- The manifest writer now stops immediately after every failed round, including ordinary ingestion failures, and reports unprocessed approved rounds.
- Existing production pilot facts with the non-canonical Australian identity remain untouched. Any repair requires a reviewed reconciliation plan and an explicit, separately authorized production repair path; this change contains no production writes.

## 2026-07-21 - Phase 5 Non-Winner Factual Checks

- Added FIA-cited, bounded production manifest cases for 2025 final driver
  standings P2, P3, and zero points; Australia race P2, P3, and DNF; and
  Australia qualifying P2 and P3.
- All championship facts remain restricted to `f1ql.driver_standings`; no
  championship total is derived from race classifications.
- Local verification passed: `npm run typecheck`, `npm run lint` (0 errors,
  117 pre-existing warnings), and `npm run test:f1ql` (172 tests).
- The guarded run found the FIA-authoritative Australia DNS and Las Vegas DSQ
  rows absent from `f1ql.event_classification`; they are recorded as coverage
  gaps, not claimed as production facts.
- Guarded Railway production golden passed on committed `5da0e0a`: 26 cases,
  23 factual, all canonical views present, one read-only transaction, and a
  five-second local statement timeout.
