# Pace Methodology

F1QL pace methodology version: `clean_air_gap_2_0s_v1`.

- Source: `laps_normalized_v2`, keyed by season, round, track, driver, session, and lap.
- Session: only FastF1 race session `R` rows are eligible.
- Lap eligibility: non-null time, valid, non-pit, non-in-lap, and non-out-lap.
- Clean air: when requested, the ingestion flag requires a 2.0-second gap to the car ahead; leaders are clean air.
- Sample rule: an event contributes only when a driver has at least two eligible laps. Per-event medians are then averaged across events.
- Version boundary: F1QL accepts only the active version above and returns it in pace results. Legacy/unversioned or different-methodology rows produce no pace result rather than being compared across seasons.

Apply `20260721_pace_correctness_v2.sql` before running any updated lap ETL. It creates a new table and leaves `laps_normalized` unchanged. Historical migration into v2 is an explicit review task: copy only a season after verifying its session labels, source completeness, and clean-air method all match this document.

## Manifest-Controlled Ingestion

FastF1 pace ingestion is never part of automatic sync. Generate an approved, read-only manifest only after the calendar date is at least 24 hours old and `race_data` has at least ten race-result rows:

```bash
npm run pace:v2:manifest -- 2026 > /approved/pace-v2-2026.json
```

Review the emitted JSON outside the database, then use that exact file as the only writer input:

```bash
npm run ingest:pace-v2:manifest -- /approved/pace-v2-2026.json
```

The writer rejects altered manifests, calendar drift, incomplete persisted state, and any full-round fingerprint/count mismatch. It checks persisted state before FastF1 is contacted, inserts only absent facts (never upserts), and records the manifest/source/fact fingerprint in `pace_v2_round_audit` in the same transaction. Audit failure rolls back the round. It stops at the first failed round and reports every approved round it did not process.

Track identities are reconciled only through the reviewed exact map in `src/etl/pace-v2-manifest.ts`. The current approved mapping is `australian_grand_prix` to canonical `melbourne`; unlisted values are never guessed, normalized, or replaced. Existing pilot facts with `track_id = australian_grand_prix` are intentionally not mutated or deleted. The writer fails closed before FastF1 for that round because its persisted identity differs from canonical `melbourne`. Remediation requires a separately reviewed reconciliation plan that inventories the affected round and fingerprints, specifies an explicit approved repair transaction and rollback/evidence procedure, and is authorized by a production primary operator. Do not run any repair automatically as part of manifest ingestion.

### Explicit Identity Repair

`repair:pace-v2:identity` is the only repair path. It is not called by manifest ingestion and is disabled unless both `PACE_V2_IDENTITY_REPAIR_ENABLED=true` and `PACE_V2_IDENTITY_REPAIR_TARGET=primary` are present. Its sole accepted manifest shape is version 1, season 2026 round 1 race session `R`, active methodology, the exact approved alias `australian_grand_prix -> melbourne`, a positive row count, source and target fact fingerprints, and a manifest fingerprint over that complete contract. Any other round, alias, session, methodology, changed manifest, existing repair audit, mixed track identity, row-count mismatch, or source/target fingerprint mismatch aborts and rolls back.

Generate the one-round manifest only from an authorized production environment with a read-only role:

```bash
PACE_V2_IDENTITY_REPAIR_MANIFEST_ENABLED=true PACE_V2_IDENTITY_REPAIR_MANIFEST_TARGET=production \
  npm run generate:pace-v2:identity-repair:production > /approved/evidence/pace-v2-round-1-identity-repair.json
```

The generator refuses localhost/loopback targets, opens one `BEGIN READ ONLY` transaction with a five-second transaction-local timeout, reads only the complete fixed round, and always rolls back. It fails unless every persisted row is the active-methodology exact source alias, then uses the canonical fact-row and manifest fingerprint functions to emit exactly one manifest JSON object. Review that retained manifest before a separate approved primary operator runs:

```bash
PACE_V2_IDENTITY_REPAIR_ENABLED=true PACE_V2_IDENTITY_REPAIR_TARGET=primary \
  npm run repair:pace-v2:identity -- --manifest /approved/pace-v2-round-1-identity-repair.json
```

Apply `20260723_pace_v2_identity_repair_audit.sql` first through the approved primary migration channel. The repair uses one serializable transaction and a five-second transaction-local timeout, locks the affected facts, validates the complete source contract before its only update, validates the target fingerprint after it, then inserts one row into immutable `pace_v2_identity_repair_audit` before commit. Retain the reviewed manifest and stdout result outside the database with UTC time, operator, deployed commit, and SHA-256. This repair has not been authorized or run against production.

Before any writer use, an approved primary operator must review and apply `migrations/20260722_pace_v2_manifest_audit.sql` after `20260721_pace_correctness_v2.sql`. Do not run either through the application role or a read-only connection.

## Schema Snapshot Contract

The committed production-schema contract is refreshed only with `npm run schema:snapshot:production` from the Railway production environment. The guarded generator requires its explicit opt-in, opens `BEGIN READ ONLY`, sets a transaction-local 10-second statement timeout, reads only `information_schema`, and rolls back. The approved v2 migration is represented by the `laps_normalized_v2` table, its 18 columns, and its six-column session-inclusive primary key; snapshot capture never backfills or alters production data.

## Production Coverage And Freshness Protocol

Run the guarded preflight only from an authorized production environment:

```bash
PACE_V2_PREFLIGHT_ENABLED=true PACE_V2_PREFLIGHT_TARGET=production npm run preflight:pace-v2:production
```

It refuses localhost and loopback targets, uses one `BEGIN READ ONLY` transaction with a transaction-local five-second timeout, always rolls back, and writes exactly one JSON object to stdout. It never invokes ingestion or writes. The report contains the v2 row total, session/methodology grouping, season/round coverage, active-methodology eligible-lap counts, explicit missing/partial conditions, and ETL audit freshness when `etl_runs_laps_normalized` exists. Save stdout outside the database as evidence; do not redirect stderr into the artifact.

The preflight's coverage query is equivalent to:

```sql
SELECT season, methodology_version, max(updated_at) AS newest_row,
       count(DISTINCT round) FILTER (WHERE session_type = 'R') AS race_rounds,
       count(*) FILTER (WHERE session_type = 'R') AS race_laps
FROM laps_normalized_v2
GROUP BY season, methodology_version
ORDER BY season, methodology_version;
```

Accept a season for F1QL pace only when it has exactly `clean_air_gap_2_0s_v1`, expected completed race rounds, and a plausible newest-row timestamp after the last intended ingestion. A missing v2 relation, a second methodology version, stale timestamp, or incomplete round count is a failed coverage/freshness check. Save the one read-only JSON/CSV artifact outside the database with UTC time, deployed commit, operator, and expected completed-round count. Do not backfill, alter, or repair production during this check.

## Selected Event Pace Artifact

For a bounded factual observation of one selected event, use the separately dual-flagged read-only command:

```bash
PACE_V2_EVENT_ARTIFACT_ENABLED=true PACE_V2_EVENT_ARTIFACT_TARGET=production \
  npm run validate:pace-v2:event:production -- 2026 1 > /approved/evidence/pace-v2-event-2026-1.json
```

It rejects loopback targets, uses one read-only transaction with a five-second local timeout, and returns at most 30 driver medians from active-methodology eligible race laps. The output is explicitly scoped as `database_observation_only` and states `external_truth: unverified_without_authoritative_artifact`; it is not an independent factual claim. To promote an observation, retain a separate authoritative external artifact and record its source, retrieval UTC time, SHA-256, selected fields, and comparison result alongside this database observation. Do not treat an absent external artifact as validation.
