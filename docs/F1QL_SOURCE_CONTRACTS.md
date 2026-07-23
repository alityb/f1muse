# F1QL Source Contracts

Contract version: `v1`  
Effective: 2026-07-22  
Applies to: `f1ql.driver_standings`, `f1ql.event_classification`,
`f1ql.qualifying_classification`, `f1ql.event_metadata`, and
`f1ql.lap_pace`.

This is the definitive source contract for the F1QL read surface. It specifies
what each relation means, not that every stored row has independent external
verification. The production evidence ledger is the authoritative record of
what was actually observed in production:
[`PRODUCTION_EVIDENCE_LEDGER.md`](PRODUCTION_EVIDENCE_LEDGER.md).

## Shared Rules

- F1QL reads only the named `f1ql` views. It must not substitute a similarly
  shaped base table or derive an official total from another source.
- `driver_id` is canonicalized at the view boundary by replacing `_` with `-`.
  Callers must use the hyphenated identifier. `team_id`, `event_id`, and
  `circuit_id` are source identifiers, not a cross-source alias service.
- A missing row means the relation has no matching source row. It does not mean
  a person, event, session, or timing value did not exist.
- `NULL` means unavailable/not recorded by the underlying source unless a
  source contract below gives a narrower meaning. F1QL does not turn `NULL`
  into zero, a position, a status, or an eligibility result.
- Observed coverage is an inventory at the capture time, not a completeness
  assertion. The 2026-07-22 authority audit observed calendar, classification,
  standings, and qualifying seasons 1950-2026; pace only in 2026 (10 events,
  22 drivers, 9,577 raw v2 rows). See ledger row 21 and
  [`PRODUCTION_DATABASE_AUTHORITY_AUDIT.md`](PRODUCTION_DATABASE_AUTHORITY_AUDIT.md).

## Standings: `f1ql.driver_standings`

**Authority and coverage.** The view projects recorded values from
`season_driver_standing`. That relation, not a sum of `race_data.race_points`,
is the championship-points and championship-position authority. Production
coverage observed in the authority audit was 1950-2026. FIA championship-points
documents are the external authority for final standings; Formula 1/FIA result
material is supplementary evidence.

| Field | Meaning and null semantics |
| --- | --- |
| `season` | Source `year`; championship season. |
| `driver_id` | `season_driver_standing.driver_id` with underscores changed to hyphens. |
| `championship_position` | Recorded season standing position; `NULL` is not a calculated rank. |
| `points` | Recorded season championship points; `NULL` is not zero and is never recomputed by F1QL. |
| `championship_won` | Source championship-winner flag; nullable source value is preserved. |

**Production factual evidence.** The bounded production corpus passed 18
checks on 2026-07-21 (ledger row 16), and the later authority audit passed 23
fixed checks (row 21). The cited final-total checks cover 2014, 2019, 2021,
2022, 2024, and 2025, with additional 2025 P2, P3, and zero-point evidence.
Exact sources and facts: [`F1QL_CORPUS_SOURCE_EVIDENCE.md`](F1QL_CORPUS_SOURCE_EVIDENCE.md#final-season-standings-checks).

**Unsupported boundary.** This contract does not certify every driver/season,
historical scoring rules, dropped-score/shared-drive eras, or identity aliases
across upstream systems.

## Race Classification: `f1ql.event_classification`

**Authority and coverage.** The view projects `race_data` joined to `race`,
restricted to `race_data.type` values `race` and `race_result`. FIA final race
classification is the external factual authority; Formula 1 results are
official supplementary authority. Production observed seasons 1950-2026 and,
at capture, 860 distinct driver IDs and 186 team IDs.

| Field | Meaning and null/status semantics |
| --- | --- |
| `season`, `round` | `race.year` and `race.round`; identify the canonical race event. |
| `driver_id` | Canonicalized `race_data.driver_id`. |
| `team_id` | Raw `race_data.constructor_id`; no underscore-to-hyphen rewrite is applied. |
| `finishing_position` | `race_data.position_number`; `NULL` is not a finish position. |
| `points` | `race_data.race_points`; `NULL` is not zero. |
| `classification_status` | Closed enum: `classified`, `dnf`, `dns`, `dsq`, `not_classified`, `withdrawn`. |
| `status_reason` | First nonblank `position_text`, otherwise `race_reason_retired`; it is explanatory source text, not a second normalized enum. |

Status precedence is definitive: trimmed, case-insensitive `position_text`
`DSQ`/`DISQUALIFIED`, `DNS`/`DID NOT START`, and `W`/`WD`/`WITHDRAWN` win in
that order. A non-null numeric position with no retirement reason is
`classified`. Then trimmed `race_reason_retired` maps `DNS`/`DID NOT START`,
`DSQ`/`DISQUALIFIED`, `NC`/`NOT CLASSIFIED`, and `W`/`WD`/`WITHDRAWN`; every
other case is `dnf`. Thus `classified` includes a recorded numeric classified
position, while no status mapping infers a missing position or points value.

**Production factual evidence.** The authority audit's 23 checks include 2014
Abu Dhabi double points, 2019 Australia fastest-lap point, 2021 Belgium's
abbreviated classification, 2022 Austria scoring, and 2024/2025 race facts
(ledger row 21). Sources and narrowed assertions are in
[`F1QL_CORPUS_SOURCE_EVIDENCE.md`](F1QL_CORPUS_SOURCE_EVIDENCE.md#cited-factual-manifest).

**Unsupported boundary.** The guarded corpus found the FIA-authoritative 2025
Australia DNS and Las Vegas DSQ absent from this view; absence is not a claim
that those decisions did not occur. Sprint classifications are not exposed.
Status normalization beyond the cited Australia DNF and source-specific
historical variation is unverified.

## Qualifying Classification: `f1ql.qualifying_classification`

**Authority and coverage.** The view projects `qualifying_results`. FIA final
qualifying classifications are the external factual authority; official Formula
1 qualifying reports are supplementary evidence. Production observed seasons
1950-2026, but that observation is not a per-event completeness claim.

| Field | Meaning and null/status semantics |
| --- | --- |
| `season`, `round` | Source qualifying event scope. |
| `driver_id` | Canonicalized `qualifying_results.driver_id`. |
| `team_id` | Source team identifier, preserved as stored. |
| `qualifying_position` | Recorded qualifying classification position; `NULL` is not a grid position or a calculated rank. |
| `best_time_ms` | Best recorded qualifying time in milliseconds; `NULL` means no recorded value. |
| `best_session` | Source session label for `best_time_ms`; `NULL` means unavailable. |
| `eliminated_in_round` | Source elimination-round value; `NULL` is not inferred from position. |
| `classification_status` | `dns` when `is_dns` is true; otherwise `dnf` when `is_dnf` is true; otherwise `classified`. Null flags are treated as false. |

Pole means `qualifying_position = 1`; it is not the post-penalty official grid
position. Production factual checks cover 2025 Australia P1/P2/P3 and event
identity (ledger rows 16 and 21; source links in
[`F1QL_CORPUS_SOURCE_EVIDENCE.md`](F1QL_CORPUS_SOURCE_EVIDENCE.md#cited-factual-manifest)).

**Unsupported boundary.** This relation has no DSQ, withdrawn, or
not-classified qualifying status; it must not be treated as a complete session
steward-decision ledger. Historical qualifying completeness and cross-source
driver aliases are unverified.

## Event Metadata: `f1ql.event_metadata`

**Authority and coverage.** The view projects `race`, optionally joined to
`grand_prix`. FIA records/archive material is the external authority; Formula 1
archive material is supplementary. Production observed seasons 1950-2026.

| Field | Meaning and null semantics |
| --- | --- |
| `season`, `round` | `race.year` and `race.round`. |
| `event_id` | Hyphenated `race.grand_prix_id`, falling back to raw `race.circuit_id`; this fallback is intentional and is not alias normalization. |
| `event_name` | First available `grand_prix.full_name`, `grand_prix.name`, then `race.official_name`; `NULL` remains unavailable. |
| `circuit_id` | Raw `race.circuit_id`; it is not normalized to `event_id`. |
| `date` | Source race date; `NULL` is unavailable source metadata. |
| `session_scope` | F1QL response annotation, not a view column: `race` by default or the requested `qualifying` scope. It does not prove a separately stored session event. |

Production factual checks include 1950 British GP metadata, 2024 Bahrain
metadata, and 2025 Australia metadata (ledger rows 16 and 21). Exact official
links are in [`F1QL_CORPUS_SOURCE_EVIDENCE.md`](F1QL_CORPUS_SOURCE_EVIDENCE.md#cited-factual-manifest).

**Unsupported boundary.** The contract does not establish every historical
event name/date/circuit alias, nor a general session calendar. `session_scope`
must not be used to infer sprint, practice, or separately scheduled session
metadata.

## Lap Pace: `f1ql.lap_pace`

**Authority and methodology.** The serving view selects the approved fact set
per race round: `fastf1_complete_race_v1` rebuild when its immutable audit
exists; otherwise `nat_pit_flags_v1` replacement when its immutable audit
exists; otherwise original `laps_normalized_v2`. It exposes only the active
`clean_air_gap_2_0s_v1` methodology to F1QL calculations. Its source is an
application timing data product, not an official season-results authority.
The selection/audit protocol is defined in
[`PACE_METHODOLOGY.md`](PACE_METHODOLOGY.md).

| Field | Meaning and null semantics |
| --- | --- |
| `season`, `round`, `event_id` | Selected fact season/round and raw `track_id` as `event_id`. |
| `driver_id` | Selected fact driver ID with underscores changed to hyphens. |
| `lap_time_seconds` | Raw selected lap time; `NULL` is excluded from F1QL pace calculations. |
| `is_valid_lap`, `is_pit_lap`, `is_in_lap`, `is_out_lap` | Eligibility flags. F1QL requires valid=true and treats nullable pit/in/out as false for filtering; source nullability is not factual proof of no pit/in/out condition. |
| `clean_air_flag` | Source methodology flag. It is required only for a `clean_air_only` request; `NULL` does not pass that request. |
| `compound`, `tyre_age_laps` | Source tyre fields; `NULL` is unavailable and does not match a requested compound. |
| `session_type` | F1QL pace calculations require `R`; no sprint, qualifying, or practice pace is exposed. |
| `methodology_version` | Selected fact methodology; F1QL requires exactly `clean_air_gap_2_0s_v1`. |

For a pace summary, F1QL excludes null-time, invalid, pit, in-lap, and out-lap
rows; optionally requires `clean_air_flag`; computes a per-driver, per-round
median; requires at least two eligible laps in a round; then averages those
round medians. A delta uses only rounds where both drivers meet that same rule.
No result is emitted by mixing methodology versions.

**Production evidence.** The fresh 2026-07-22 preflight reported `ready`:
9,577 v2 rows over ten 2026 rounds; the serving view selected round 1's
identity-repair bridge and rounds 2-10's immutable reconciliations (ledger row
22). The separate round-2 official-artifact comparison exactly matched 815 of
816 comparable raw v2 laps after an exact racing-number/TLA identity check
(ledger row 20). That is narrow raw-lap and identity evidence, not pace-result
validation.

**Unsupported boundary.** No external artifact currently supplies the shared
driver mapping and clean-air, pit, in-lap, and out-lap fields needed to validate
an F1QL filtered median. The official timing artifacts therefore do not validate
F1QL pace summaries or deltas. Pace coverage outside observed 2026 data,
official clean-air/pit eligibility, weather/retirement causality, and raw source
completeness remain unsupported. See
[`PACE_METHODOLOGY.md`](PACE_METHODOLOGY.md#official-validation-layers-1-3)
and the ledger rows 19, 20, and 22.

**Promotion policy.** `clean_air_gap_2_0s_v1` remains coverage-only until one
authority maps every compared completed lap to driver identity and supplies its
validity, pit, in-lap, out-lap, and numeric car-ahead-gap semantics. FIA's 2026
Australian Race History Chart is retained only for its printed raw lap times,
leader-relative gaps, and `PIT` marker; it does not define the missing fields.
No filtered pace golden may be promoted from a partial overlap or a derived
car-ahead gap. F1QL currently exposes no unfiltered raw-timing metric, so no
factual pace golden is eligible under the current product contract.

## Evidence Maintenance

When a production observation materially changes one of these contracts, retain
the stdout or source artifact, calculate its SHA-256, add the ledger row, then
update this contract in the same documentation change. Do not upgrade a
coverage observation into an external factual claim without a cited authority
and a bounded comparison.
