# Worklog

## 2026-07-21 - Phase 5 Non-Winner Factual Checks

- Added FIA-cited, bounded production manifest cases for 2025 final driver
  standings P2, P3, and zero points; Australia race P2, P3, DNF, and DNS; Las
  Vegas DSQ; and Australia qualifying P2 and P3.
- All championship facts remain restricted to `f1ql.driver_standings`; no
  championship total is derived from race classifications.
- Local verification passed: `npm run typecheck`, `npm run lint` (0 errors,
  117 pre-existing warnings), and `npm run test:f1ql` (172 tests).
- Production golden execution is recorded after the committed guarded Railway
  run in `PROGRESS.md`.
