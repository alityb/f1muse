# F1QL Launch Capability Matrix

Status: Phase 10 launch architecture complete.

## Public Answer Authorities

| Capability | Scope | Authority | Launch status |
|---|---|---|---|
| Race classification | One resolved event; all, winner, podium, top-N, exact position, one driver, or reviewed status | Official race classification plus event metadata | Retained |
| Qualifying classification | One resolved event; all, pole, top-N, exact position, one driver, or reviewed status | Recorded qualifying classification plus event metadata | Retained |
| Final driver standings | Explicit final seasons 1950-2025 | Recorded final standings | Retained |
| Current driver standings | Explicit latest-recorded 2026 only | Latest successful Jolpica standings snapshot | Retained with `season_in_progress` caveat |
| Driver season official summary | One driver, one final season | Recorded final position and points only | Retained |
| Driver career official summary | One driver, fixed 1950-2025 final-season scope | Best recorded final position and recorded standings-row count | Retained |
| Final multi-driver ranking | Exact reviewed three-driver 2025 form | Official championship position | Retained |
| Career wins by circuit | One driver, 1950-2025 | Race P1 classification joined to canonical circuit identity | Retained |
| Race season H2H | Two ordered drivers, one final season, shared numeric positions | Race classification | Retained |
| Qualifying season H2H | Two ordered drivers, one final season, shared numeric positions | Qualifying classification | Retained |
| Official two-driver results comparison | Exact reviewed 2025 Norris/Piastri form | Final standings plus race and qualifying position H2H | Retained |
| Named-event race comparison | Exact reviewed Silverstone 2025 Verstappen/Norris form | Race classification plus event metadata | Retained |
| Qualifying P1 counts | One driver/season or one driver over 1950-2025 | `qualifying_position = 1` | Retained |
| Qualifying top-ten counts/ranking | One driver/season or one season ranking | Recorded P1-P10 qualifying positions | Retained |

All 30 launch-parity cases are contracted. Exact accepted wording remains
closed and versioned; the table describes semantics, not permission to accept
arbitrary paraphrases.

## Public Retirement Boundary

| Family | Status | Reason |
|---|---|---|
| Pace gaps, fastest-driver rankings, tyre/stint/clean-air analytics | Retired from launch answers | No reviewed public answer authority; classification is not a pace proxy |
| Weather-conditioned comparisons | Retired | No single reviewed factual contract |
| Teammate gap and dual-session gap products | Retired | Legacy derived products are not equivalent to reviewed official metrics |
| Trend summaries | Retired | No reviewed longitudinal metric contract |
| Synthetic performance vectors and broad profiles | Replaced/retired | Mixed authorities and synthetic scores |
| Position-to-time qualifying gaps | Replaced | Launch uses position H2H only |
| Legacy Q3 proxy | Replaced | Launch counts explicit recorded top-ten qualifying positions |
| Sprint, post-penalty grid, constructor, interim standings | Unsupported | Outside launch source/policy contract |
| Arbitrary windows, multi-season comparisons, team filters, broad composites | Unsupported | Outside reviewed launch scope |

The Phase 8/9 sealed official lap fixtures and pace operations remain research
and regression assets. Their existence does not authorize public execution.

## Legacy Family Dispositions

The former 24-family inventory has an exhaustive Phase 10 disposition:

| Historical family | Disposition | Launch replacement/boundary |
|---|---|---|
| `driver_season_summary` | Port | Final-season official summary or explicit current standings |
| `driver_career_summary` | Port | Standings-only career summary |
| `driver_profile_summary` | Replace | Final-season official summary only |
| `driver_trend_summary` | Retire | No launch replacement |
| `driver_head_to_head_count` | Port | Race or qualifying position H2H |
| `driver_performance_vector` | Retire | No synthetic vector |
| `driver_multi_comparison` | Replace | Exact official final-position ranking |
| `driver_matchup_lookup` | Replace | Qualifying position H2H |
| `driver_vs_driver_comprehensive` | Replace | Pinned official-results comparison |
| `driver_career_wins_by_circuit` | Port | Official race wins by canonical circuit |
| `teammate_comparison_career` | Replace | Explicit season classification H2H; no teammate inference |
| `season_driver_vs_driver` | Replace | Explicit race/qualifying position H2H |
| `cross_team_track_scoped_driver_comparison` | Replace | Pinned named-event race classification comparison |
| `teammate_gap_summary_season` | Retire | No launch replacement |
| `teammate_gap_dual_comparison` | Retire | No launch replacement |
| `track_fastest_drivers` | Retire | No launch replacement |
| `race_results_summary` | Port | Reviewed race result selections |
| `driver_pole_count` | Port | Season qualifying P1 count |
| `driver_career_pole_count` | Port | Career qualifying P1 count through 2025 |
| `driver_q3_count` | Replace | Season top-ten qualifying count |
| `season_q3_rankings` | Replace | Season top-ten qualifying ranking |
| `qualifying_gap_teammates` | Replace | Qualifying position H2H; no teammate/time-gap claim |
| `qualifying_gap_drivers` | Replace | Qualifying position H2H |
| `qualifying_results_summary` | Port | Reviewed qualifying result selections |

There is no legacy execution fallback after cutover.

## Route Capability

| Route | Execution boundary |
|---|---|
| `POST /nl-query` | Public reviewed `AnswerEnvelope`; all answer/release/canary/read-only gates apply |
| `POST /program/answer` | Internal bearer principal; same deterministic answer gates |
| `POST /program/translate` | Permanently shadow-only and non-executing |
| `POST /program` | Caller-supplied F1QL, separately enabled and fully validated |
| `POST /program/verified/:id` | Curated registry only; guarded verified execution |
| `GET /share/:id`, `GET /share-feed` | Immutable retrieval only; no query execution |
| Direct driver GET routes | Non-NL endpoint contracts retained |

Removed: `/query`, `POST /share`, suggestions, capabilities, legacy
natural-language routers, and natural-language intent/result caches.
