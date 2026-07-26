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

### 2025 Expansion Preparation

Historical 2025 pace remains unserved. Preparation is deliberately separate from
the generic ingestion manifest and cannot be consumed by any writer. The
dual-flagged command below performs only one loopback-refusing `BEGIN READ ONLY`
transaction with a five-second local timeout and rollback:

```bash
PACE_V2_2025_EXPANSION_PREPARE_ENABLED=true PACE_V2_2025_EXPANSION_PREPARE_TARGET=production \
  npm run --silent prepare:pace-v2:2025-expansion:production > /approved/evidence/pace-v2-2025-expansion-preparation.json
```

It selects the earliest stabilized 2025 race round with at least ten canonical
starters, no existing v2 race facts, no existing manifest audit, and an enabled
immutable `pace_v2_round_audit` trigger. The emitted fingerprint binds the
round, canonical-starter identity set, and zero-coverage/audit baseline. Its
`pilot_status` is always `requires_external_source_review`: it is not an
ingestion approval and does not authorize a production write. If any prerequisite
is absent, or no candidate satisfies every predicate, it emits a typed refusal.

Before any later pilot can be proposed, retain and independently review a
FastF1/source artifact that establishes complete race-session coverage and the
same clean-air, validity, pit, in-lap, and out-lap semantics. Then create a new
writer-specific authorization; do not repurpose this preparation manifest or
run generic ingestion against 2025.

Run the guarded preflight only from an authorized production environment:

```bash
PACE_V2_PREFLIGHT_ENABLED=true PACE_V2_PREFLIGHT_TARGET=production npm run preflight:pace-v2:production
```

It refuses localhost and loopback targets, uses one `BEGIN READ ONLY` transaction with a transaction-local five-second timeout, always rolls back, and writes exactly one JSON object to stdout. It never invokes ingestion or writes. The report contains the v2 row total, session/methodology grouping, season/round coverage, active-methodology eligible-lap counts, explicit missing/partial conditions, ETL audit freshness when `etl_runs_laps_normalized` exists, and per-round pace audit readiness. Save stdout outside the database as evidence; do not redirect stderr into the artifact.

Every complete race fact set normally requires an exact `pace_v2_round_audit` row: current fact fingerprint, row count, and active methodology must all match. A missing manifest audit can be bridged only for the fixed repaired round (2026 round 1) when `pace_v2_identity_repair_audit` has its enabled immutable trigger and its exact `track_identity_exact_alias_v1` repair-manifest fingerprint, target fingerprint, row count, and methodology match the complete current facts. A present-but-mismatched manifest audit, a disabled/missing immutable trigger, any fingerprint/count/method mismatch, or an unaudited round remains an error; repair evidence never overrides a failed manifest audit.

### Immutable Manifest-Audit Reconciliation

`pace_v2_round_audit` is never rewritten. When an existing audit differs from current complete facts only in `fact_fingerprint`, an approved operator may record separate immutable evidence in `pace_v2_round_audit_reconciliation`. This path does not repair facts, update the original audit, or accept changes to session `R`, row count, active methodology, or any other audit field.

Apply `20260724_pace_v2_audit_reconciliation.sql` through the approved primary migration channel first. Generate one reviewed manifest per affected round from an authorized production read-only environment:

```bash
PACE_V2_AUDIT_RECONCILIATION_MANIFEST_ENABLED=true PACE_V2_AUDIT_RECONCILIATION_MANIFEST_TARGET=production \
  npm run generate:pace-v2:audit-reconciliation:production -- 2026 2 > /approved/evidence/pace-v2-audit-reconciliation-2026-2.json
```

The generator rejects loopback, uses one `BEGIN READ ONLY` transaction with a five-second local timeout, reads only the original audit and complete selected race fact set, and rolls back. It emits evidence only if the original audit session, count, and methodology exactly match the current facts and its stored fingerprint differs. Independently review each manifest, then an approved primary operator may insert evidence:

```bash
PACE_V2_AUDIT_RECONCILIATION_ENABLED=true PACE_V2_AUDIT_RECONCILIATION_TARGET=primary \
  npm run reconcile:pace-v2:audit -- --manifest /approved/evidence/pace-v2-audit-reconciliation-2026-2.json
```

The reconciler uses one serializable transaction and five-second local timeout, verifies its evidence relation and immutable trigger, locks the original audit and facts, repeats the exact session/count/methodology and fingerprint-only checks, then inserts one evidence row. It never updates facts or `pace_v2_round_audit`. Retain reviewed manifest and stdout with UTC time, operator, deployed commit, and SHA-256. Preflight accepts this evidence only when its immutable trigger, method, manifest fingerprint, original fingerprint, current fingerprint, count, and methodology exactly match; it otherwise remains an error.

### NaT Pit-Flag Replacement Facts

2026 race rounds 2-10 were poisoned when absent FastF1 pit timestamps (`NaT`) were treated as present. Their original `laps_normalized_v2` rows and all prior immutable audits must not be updated, deleted, or repurposed. `20260725_pace_v2_nat_replacement.sql` adds a separate, deliberately narrow `nat_pit_flags_v1` replacement fact relation and immutable approval audit. It is constrained to exactly the reviewed 2026 race-round range and active methodology; the replacement facts cannot be updated or deleted, and no facts can be added after approval.

F1QL's `f1ql.lap_pace` uses original v2 facts for every healthy round. It switches an affected round only when that round has an immutable `nat_pit_flags_v1` approval record, so an unapproved, partial, or unaudited replacement is never visible to F1QL. The writer verifies each retained original round is still wholly in the known poison class, has its exact reviewed fingerprint and row count, and has exactly the same lap identities as the corrected artifact. The corrected artifact must no longer retain the all-three-flags poison class.

This is an explicit primary-only procedure, not ingestion and not a production command to run automatically. First apply the reviewed migration through the approved primary migration channel. The production result and current audit state are indexed in `docs/PRODUCTION_EVIDENCE_LEDGER.md`. From an authorized read-only production environment, generate and independently review the one complete nine-round manifest:

```bash
PACE_V2_NAT_REPLACEMENT_MANIFEST_ENABLED=true PACE_V2_NAT_REPLACEMENT_MANIFEST_TARGET=production \
  npm run --silent generate:pace-v2:nat-replacement:production > /approved/evidence/pace-v2-nat-replacement-manifest.json
```

The generator uses one read-only transaction, a five-second local timeout, and rollback. It emits no manifest unless every fixed round is complete, active-methodology, and still has all three poisoned flags. The corrected artifact was not committed and cannot be recreated locally without approved FastF1 identity evidence. Generate the identity evidence only from an authorized production environment:

```bash
PACE_V2_NAT_IDENTITY_MAP_ENABLED=true PACE_V2_NAT_IDENTITY_MAP_TARGET=production \
  npm run --silent generate:pace-v2:nat-identity-map:production
```

It queries only canonical 2026 rounds 2-10 race-result and driver identities in one `BEGIN READ ONLY` transaction with a five-second local timeout, then rolls back. It fetches each FastF1 Race session and accepts only canonical starters plus explicit canonical DNS/withdrawal exclusions; it does not use persisted v2 rows to define the map. It rejects mixed/missing tracks, ambiguous codes, counts, or any FastF1/canonical identity mismatch. Its only artifact is a newly created mode-0600 JSON file below the OS temporary directory; stdout is one report containing that absolute `output` path and its SHA-256. Pass that path directly to the corrected-facts generator. The only accepted artifact shape is `{version: 2, source: "canonical_race_results_fastf1_identity_map", season: 2026, rounds: [...]}`; legacy v1 `approved_fastf1_identity_map` artifacts are rejected. The manifest remains the only corrected-facts round selector; the generator accepts exactly rounds 2-10, writes only to a newly created OS-temporary path, and emits per-round corrected counts/fingerprints on stdout:

```bash
artifact="$(mktemp -t pace-v2-nat-corrected-facts).json"
npm run --silent generate:pace-v2:nat-corrected-facts -- \
  --manifest /approved/evidence/pace-v2-nat-replacement-manifest.json \
  --identity-map /absolute/OS-temporary/pace-v2-nat-identity-map-*/identity-map.json \
  --output "$artifact"
```

The generator rejects a source session outside the requested race, an identity map outside the fixed rounds, duplicate/missing facts, a row count different from the manifest, or an unchanged all-three-flags poison class. Its output is the writer artifact JSON `{version: 1, replacement_version: "nat_pit_flags_v1", methodology_version: "clean_air_gap_2_0s_v1", facts: [...]}`. Retain the source identity map, generated artifact, stdout count/fingerprint report, extractor revision, and SHA-256 outside the database. An approved primary operator may then run:

```bash
PACE_V2_NAT_REPLACEMENT_ENABLED=true PACE_V2_NAT_REPLACEMENT_TARGET=primary \
  npm run --silent replace:pace-v2:nat-pit-flags -- --manifest /approved/evidence/pace-v2-nat-replacement-manifest.json --facts "$artifact"
```

The writer uses one serializable transaction and a five-second local timeout. It inserts all replacement facts then their immutable manifest/original/replacement fingerprint audit in the same transaction; any failed round rolls back the complete batch. `--silent` is required so npm lifecycle output does not contaminate JSON evidence. A refusal emits a non-sensitive `reason` code: contract and preflight failures are distinct from configuration, permission, timeout, serialization, duplicate-key, and unexpected runtime failures. Retain both input artifacts and stdout with UTC time, operator, deployed commit, and SHA-256.

The current production preflight and its retained artifact are recorded in `docs/PRODUCTION_EVIDENCE_LEDGER.md`; the query below describes the original-v2 coverage component, while serving eligibility is read from `f1ql.lap_pace` so approved replacements are represented.

The original-v2 coverage query is equivalent to:

```sql
SELECT season, methodology_version, max(updated_at) AS newest_row,
       count(DISTINCT round) FILTER (WHERE session_type = 'R') AS race_rounds,
       count(*) FILTER (WHERE session_type = 'R') AS race_laps
FROM laps_normalized_v2
GROUP BY season, methodology_version
ORDER BY season, methodology_version;
```

Accept a season for F1QL pace only when it has exactly `clean_air_gap_2_0s_v1`, expected completed race rounds, and a plausible newest-row timestamp after the last intended ingestion. A missing v2 relation, a second methodology version, stale timestamp, or incomplete round count is a failed coverage/freshness check. Save the one read-only JSON/CSV artifact outside the database with UTC time, deployed commit, operator, and expected completed-round count. Do not backfill, alter, or repair production during this check.

### Round-2 Missing-Driver Timing Evidence

The 2026 round-2 FastF1 Race payload currently has one positive lap-number row with a null lap time for `ALB`, `BOR`, `NOR`, and `PIA`. The normalizer correctly excludes those rows. The FIA final classification confirms all four participated in the Chinese Grand Prix, but it is a classification document, not a lap-by-lap timing source, so it must not be used to derive times.

The only automated external acquisition is intentionally locked to the reviewed FIA final-classification URL. It performs no database operation, validates HTTPS/FIA host/PDF signature, writes a new mode-0600 PDF below the OS temporary directory, and reports its SHA-256. It never generates pace facts:

```bash
npm run --silent fetch:pace-v2:round2-timing-artifact
```

Retain the PDF and JSON report outside the database. An operator must separately obtain a FIA/F1 official lap-analysis or timing feed whose artifact shows a valid timed race lap for each driver, hash it, and independently review its driver/lap mapping before any updated identity map or incomplete-rebuild facts are generated. If that source is unavailable, keep the round incomplete; neither a final classification nor a source gap authorizes invented timing.

The official Formula 1 historical `TimingData.jsonStream` archive is the reviewed candidate individual-lap comparison artifact for this event. Its collector is fixed to the exact HTTPS URL, rejects any other host/path or malformed stream, writes a new mode-0600 file below the OS temporary directory, and emits the raw-file SHA-256, byte count, retrieval UTC, and a SHA-256 fingerprint for each required driver's sorted `(lap_number, seconds)` list:

```bash
npm run --silent fetch:pace-v2:round2-lap-timing-artifact
```

The report is an independent raw timed-lap median recomputation only: it parses every final observed `NumberOfLaps`/`LastLapTime.Value` pair for racing numbers `1` (Norris), `5` (Bortoleto), `23` (Albon), and `81` (Piastri), deduplicates by lap number, sorts numerically, and takes the conventional middle value (or mean of the two middle values). It emits `required_driver_timing_coverage: "incomplete"` rather than implying a comparison if any required driver lacks a completed timed lap. It is deliberately not a clean-air or pit/in/out-filtered pace median: this archived stream does not provide a reviewed, durable mapping for all application eligibility inputs. Do not compare its medians to `f1ql.lap_pace` as pass/fail evidence. Retain the raw stream and JSON report outside the database; it has no fact-generation or database path.

On 2026-07-22 this workspace's direct Node retrieval received an HTTP-success response that failed the required timing-stream signature, including after the documented Formula 1 origin/referer request headers. The collector therefore uses the available system TLS client with those same fixed headers, then applies its own exact URL and stream-signature validation before retaining anything. This transport change does not alter source content or the evidence boundary.

The retained 2026-07-22 artifact has SHA-256 `380259ce59c9e7b5b81aa4872106e2a3ba9e476fd7129d31f27fcc45aa2b747d` and 5,248,701 bytes. It reports `required_driver_timing_coverage: "incomplete"`: the archive contains no completed `NumberOfLaps`/`LastLapTime.Value` pair for any of the four required racing numbers. This is a source-coverage limitation, not evidence that a driver did not participate or that a lap time should be invented. No individual-lap comparison, raw median, or pace-validation claim is made from this artifact.

### Multi-Round Official Timing Coverage

The fixed 2026 collector covers rounds 1 (Australian), 2 (Chinese), 3 (Japanese), 6 (Miami), and 7 (Canadian):

```bash
npm run --silent fetch:pace-v2:official-timing-2026
```

It permits only five exact Formula 1 `TimingData.jsonStream` HTTPS URLs, writes each byte-preserved stream to a new mode-0600 OS-temporary file, and reports retrieval UTC, source URL, byte count, SHA-256, and a fingerprinted raw timed-lap summary. The selection targets normal/dry, retirement-limited, wet/disrupted, pit-heavy, and current-season coverage respectively. Those are coverage labels, not validated race-condition facts: `TimingData` alone does not establish weather, disruption cause, pit eligibility, retirement status, or the application's clean-air inputs. Every report explicitly says so.

| Round | Event | Coverage target | SHA-256 | Timed drivers |
| ---: | --- | --- | --- | ---: |
| 1 | Australian Grand Prix | normal/dry | `a2521be4b468f9ec4c61211558521c993269eb34c24c600e1fa3c90ebb251c8d` | 20 |
| 2 | Chinese Grand Prix | retirement-limited | `380259ce59c9e7b5b81aa4872106e2a3ba9e476fd7129d31f27fcc45aa2b747d` | 18 |
| 3 | Japanese Grand Prix | wet/disrupted | `90581624eb501ce980bcfcaf6b0d9666dda7be82a5cf4a39f1bc75c90b536bab` | 22 |
| 6 | Miami Grand Prix | pit-heavy | `8f095d21d41706a1c6ea7e69dd8f3dfd51eb7883e990579d974f6a93b0f536ee` | 22 |
| 7 | Canadian Grand Prix | current season | `8b177bb8d267945985b40bfe14b7bcff0a68941ee2e5633a3c050e182825eb9b` | 21 |

Only final `NumberOfLaps` with `LastLapTime.Value`, and `Stints.LapNumber` with `Stints.LapTime`, are recomputed. The resulting statistic is a raw per-driver timed-lap median, never an F1QL clean-air/pit/in/out-filtered result. No database is contacted and no facts are produced. Retain the raw streams and single JSON report outside the database; add an external production golden comparison only after an authority supplies the same mapped eligibility fields.

`fetch:pace-v2:official-context-2026` retains independent official `WeatherData`, `RaceControlMessages`, and `TimingAppData` streams for the same fixed events. Its only derived context facts are an observed `Rainfall: "1"`, exact `SAFETY CAR DEPLOYED` messages, and the number of raw stint-record updates. It does not convert stint records to pit stops, nor use any context stream to infer a clean-air, pit, in-lap, out-lap, or retirement flag.

The retained context evidence establishes no rainfall observation in r1/r2/r3/r7, a rainfall observation in r6, safety-car deployment in r2/r3/r6, and no safety-car deployment in r1/r7. It therefore validates dry and disrupted/wet event context where literal fields exist, but not the original retirement-limited or pit-heavy selection targets. `TimingAppData`'s repeated incremental stint records do not establish pit-stop count or pit eligibility without an additional reviewed interpretation contract.

### Rounds 1-10 Artifact Inventory

`data/pace-v2-official-2026-coverage-matrix.json` is the compact output-derived coverage matrix from the 2026-07-22 evidence run. It retains source URLs and SHA-256 values, not raw artifacts. Re-run it with:

```bash
npm run --silent fetch:pace-v2:official-inventory-2026
```

| Rounds | Timing artifact | Timed / observed drivers | Literal context result |
| --- | --- | ---: | --- |
| 1 | retained | 20 / 22 | no rainfall or safety-car deployment observed |
| 2 | retained | 18 / 22 | no rainfall; safety-car deployment observed |
| 3 | retained | 22 / 22 | no rainfall; safety-car deployment observed |
| 4-5 | unavailable from reviewed URLs | - | unavailable |
| 6 | retained | 22 / 22 | rainfall and safety-car deployment observed |
| 7 | retained | 21 / 22 | no rainfall or safety-car deployment observed |
| 8 | retained | 21 / 22 | no rainfall; safety-car deployment observed |
| 9 | unavailable from reviewed URL | - | unavailable |
| 10 | retained | 22 / 22 | no rainfall or safety-car deployment observed |

The matrix's retirement classification is limited to literal `RETIRED` race-control messages; no such message was observed in retained streams. Its pit-heavy classification remains unestablished because incremental `TimingAppData.Stints` updates are not a reviewed pit-stop interpretation. V2 eligible-driver coverage is deliberately `not_assessed`: proving the overlap requires a separately retained read-only v2 observation and reviewed racing-number-to-driver mapping, and neither source shares F1QL's clean-air, pit, in-lap, and out-lap eligibility fields. This inventory makes no median claim or F1QL pace comparison.

### Official Validation Layers 1-3

`validate:pace-v2:official-layers:production` binds retained `TimingData.jsonStream` and `DriverList.jsonStream` files to the committed round URL/SHA-256 matrix, then performs one bounded `BEGIN READ ONLY` `laps_normalized_v2` observation with a five-second statement timeout. It requires `PACE_V2_OFFICIAL_LAYERS_ENABLED=true` and `PACE_V2_OFFICIAL_LAYERS_TARGET=production`, rejects loopback, and never writes. It reads the raw v2 facts because the deployed view does not expose lap numbers required for per-lap evidence. The unapplied Phase 8 migration `20260731_f1ql_lap_pace_lap_number.sql` adds that structural field but does not change this validator or establish official completeness:

```bash
PACE_V2_OFFICIAL_LAYERS_ENABLED=true PACE_V2_OFFICIAL_LAYERS_TARGET=production \
  npm run --silent validate:pace-v2:official-layers:production -- 2 /retained/TimingData.jsonStream /retained/DriverList.jsonStream
```

For round 2, the hashed official DriverList supplies each racing number and TLA. The validator accepts an identity only when that number exactly matches canonical `race_data.driver_number` and its TLA exactly matches canonical `driver.abbreviation`; it fails closed for ambiguity, omissions, or any mismatch. Layer 1 reports that mapping and the v2 subset. Layer 2 emits an exact numeric, zero-tolerance raw lap-time comparison for every v2 driver/lap, plus both directions of coverage gap. Layer 3 emits one v2-lap evidence record with every v2 exclusion reason (`missing time`, `invalid`, `pit`, `in lap`, `out lap`). The retained official streams do not carry reviewed clean-air, pit, in-lap, or out-lap fields, so official clean-air/pit metadata remains `unavailable_not_inferred`; neither eligibility nor pace-filtering facts are inferred from timing equality.

## Selected Event Pace Artifact

For a bounded factual observation of one selected event, use the separately dual-flagged read-only command:

```bash
PACE_V2_EVENT_ARTIFACT_ENABLED=true PACE_V2_EVENT_ARTIFACT_TARGET=production \
  npm run --silent validate:pace-v2:event:production -- 2026 1 > /approved/evidence/pace-v2-event-2026-1.json
```

It rejects loopback targets, uses one read-only transaction with a five-second local timeout, and returns at most 30 driver medians from the serving `f1ql.lap_pace` selection of active-methodology eligible race laps. A refusal identifies its safe reason; median-query failures additionally name the `eligible_lap_driver_median` predicate and PostgreSQL SQLSTATE. The output is explicitly scoped as `database_observation_only` and states `external_truth: unverified_without_authoritative_artifact`; it is not an independent factual claim. To promote an observation, retain a separate authoritative external artifact and record its source, retrieval UTC time, SHA-256, selected fields, and comparison result alongside this database observation. Do not treat an absent external artifact as validation.
