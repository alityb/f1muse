# Query Contract: Backend ↔ Frontend

**Version**: 2026-02-06
**Total Query Kinds**: 19

This document is the **single source of truth** for the API contract between backend and frontend.

## Query Kind Matrix

| # | Kind | Data Source | NL Reliability | Frontend |
|---|------|-------------|----------------|----------|
| 1 | `driver_season_summary` | Lap Data | **RELIABLE** | VISUALIZED |
| 2 | `driver_career_summary` | F1DB | **RELIABLE** | VISUALIZED |
| 3 | `driver_profile_summary` | Mixed | UNRELIABLE | VISUALIZED |
| 4 | `driver_trend_summary` | Lap Data | UNRELIABLE | VISUALIZED |
| 5 | `driver_head_to_head_count` | F1DB | UNRELIABLE | VISUALIZED |
| 6 | `driver_performance_vector` | Lap Data | UNRELIABLE | VISUALIZED |
| 7 | `driver_multi_comparison` | Lap Data | UNRELIABLE | VISUALIZED |
| 8 | `driver_matchup_lookup` | F1DB | UNRELIABLE | VISUALIZED |
| 9 | `season_driver_vs_driver` | Lap Data | **RELIABLE** | VISUALIZED |
| 10 | `cross_team_track_scoped_driver_comparison` | Lap Data | **RELIABLE** | VISUALIZED |
| 11 | `teammate_gap_summary_season` | Lap Data | **RELIABLE** | VISUALIZED |
| 12 | `teammate_gap_dual_comparison` | Lap Data | **RELIABLE** | VISUALIZED |
| 13 | `track_fastest_drivers` | Lap Data | **RELIABLE** | VISUALIZED |
| 14 | `race_results_summary` | F1DB | **RELIABLE** | VISUALIZED |
| 15 | `driver_pole_count` | F1DB | **RELIABLE** | VISUALIZED |
| 16 | `driver_q3_count` | F1DB | **RELIABLE** | VISUALIZED |
| 17 | `season_q3_rankings` | F1DB | **RELIABLE** | VISUALIZED |
| 18 | `qualifying_gap_teammates` | Lap Data | **RELIABLE** | VISUALIZED |
| 19 | `qualifying_gap_drivers` | F1DB | **RELIABLE** | VISUALIZED |

## Summary

- **RELIABLE via NL**: 13 (68%) - natural language queries consistently route correctly
- **UNRELIABLE via NL**: 6 (32%) - use REST endpoints for guaranteed access
- **VISUALIZED**: 19 (100%)

### NL Reliability Explained

**RELIABLE**: Natural language queries consistently route to this query kind.

**UNRELIABLE**: The LLM often misclassifies these queries:
- `driver_profile_summary` → classified as `driver_season_summary`
- `driver_trend_summary` → classified as `driver_career_summary`
- `driver_performance_vector` → classified as `driver_season_summary`
- `driver_multi_comparison` → classified as `season_driver_vs_driver`
- `driver_head_to_head_count` → classified as `season_driver_vs_driver`
- `driver_matchup_lookup` → classified as `season_driver_vs_driver`

For UNRELIABLE kinds, use REST endpoints:
- `/driver/:driver_id/profile` → `driver_profile_summary`
- `/driver/:driver_id/trend` → `driver_trend_summary`

## Data Source Categories

### F1DB (Official Records)
Uses official race/qualifying results, standings, career statistics.
- `driver_career_summary`
- `driver_head_to_head_count`
- `driver_matchup_lookup`
- `race_results_summary`
- `driver_pole_count`
- `driver_q3_count`
- `season_q3_rankings`
- `qualifying_gap_drivers`

### Lap Data (Timing Analysis)
Uses lap-by-lap timing data for pace calculations.
- `driver_season_summary`
- `driver_trend_summary`
- `driver_performance_vector`
- `driver_multi_comparison`
- `season_driver_vs_driver`
- `cross_team_track_scoped_driver_comparison`
- `teammate_gap_summary_season`
- `teammate_gap_dual_comparison`
- `track_fastest_drivers`
- `qualifying_gap_teammates`

### Mixed
Combines multiple data sources.
- `driver_profile_summary`

---

## Detailed Payload Specifications

### 1. driver_season_summary

**Data Source**: Lap Data

```typescript
{
  type: 'driver_season_summary',
  season: number,
  driver_id: string,
  wins: number,
  podiums: number,
  dnfs: number,
  race_count: number,
  avg_race_pace: number | null,
  laps_considered: number
}
```

**Trust Signals**: season, no normalization (raw stats)

---

### 2. driver_career_summary

**Data Source**: F1DB (VISUALIZED)

```typescript
{
  type: 'driver_career_summary',
  driver_id: string,
  championships: number,
  seasons_raced: number,
  career_podiums: number,
  career_wins: number,
  pace_trend_start_season: number,
  pace_trend_start_value: number,
  pace_trend_end_season: number,
  pace_trend_end_value: number,
  pace_trend_per_season: number
}
```

**Trust Signals**: "F1DB official records"

---

### 3. driver_profile_summary

**Data Source**: Mixed

```typescript
{
  type: 'driver_profile_summary',
  driver_id: string,
  name: string,
  team_id: string | null,
  nationality: string,
  career_stats: { wins, podiums, poles, championships },
  best_tracks: TrackPerformanceEntry[],
  worst_tracks: TrackPerformanceEntry[],
  teammate_comparison: { ... } | null,
  recent_seasons: SeasonPerformanceEntry[]
}
```

---

### 4. driver_trend_summary

**Data Source**: Lap Data

```typescript
{
  type: 'driver_trend_summary',
  driver_id: string,
  start_season: number,
  end_season: number,
  seasons_analyzed: number,
  trend_direction: 'improving' | 'declining' | 'stable',
  slope_per_season: number,
  confidence_level: CoverageLevel,
  season_values: number[]
}
```

---

### 5. driver_head_to_head_count

**Data Source**: F1DB

```typescript
{
  type: 'driver_head_to_head_count',
  driver_a_id: string,
  driver_b_id: string,
  driver_a_wins: number,
  driver_b_wins: number,
  ties: number,
  shared_events: number,
  metric: HeadToHeadMetric,
  season: number,
  scope: HeadToHeadScope,
  filters_applied: HeadToHeadFiltersApplied
}
```

---

### 6. driver_performance_vector

**Data Source**: Lap Data

```typescript
{
  type: 'driver_performance_vector',
  driver_id: string,
  season: number,
  qualifying_percentile: number,
  race_pace_percentile: number,
  consistency_score: number,
  street_delta: number | null,
  wet_delta: number | null,
  laps_considered: number
}
```

---

### 7. driver_multi_comparison

**Data Source**: Lap Data

```typescript
{
  type: 'driver_multi_comparison',
  season: number,
  metric: MultiComparisonMetric,
  results: DriverMultiComparisonEntry[],
  laps_considered: number
}
```

---

### 8. driver_matchup_lookup

**Data Source**: F1DB (precomputed)

```typescript
{
  type: 'driver_matchup_lookup',
  season: number,
  driver_a_id: string,
  driver_b_id: string,
  metric: HeadToHeadMetric,
  driver_a_wins: number,
  driver_b_wins: number,
  ties: number,
  shared_events: number,
  source: 'precomputed_matrix'
}
```

---

### 9. season_driver_vs_driver (VISUALIZED)

**Data Source**: Lap Data

```typescript
{
  type: 'season_driver_vs_driver',
  season: number,
  driver_a: string,
  driver_b: string,
  metric: 'normalized_percent_pace',
  driver_a_value: number,
  driver_b_value: number,
  difference: number,
  normalization: 'session_median_percent',
  driver_a_laps: number,
  driver_b_laps: number,
  laps_considered: number,
  shared_races: number,
  coverage_status: 'valid' | 'low_coverage' | 'insufficient',
  units: 'percent'
}
```

**Trust Signals**: season, "Session-median normalized", "Lap data"

---

### 10. cross_team_track_scoped_driver_comparison

**Data Source**: Lap Data

```typescript
{
  type: 'cross_team_track_scoped_driver_comparison',
  season: number,
  track_id: string,
  driver_a_id: string,
  driver_b_id: string,
  driver_a_avg_pace: number,
  driver_b_avg_pace: number,
  gap_seconds: number,
  driver_a_laps: number,
  driver_b_laps: number,
  overlap_laps: number
}
```

---

### 11. teammate_gap_summary_season (VISUALIZED)

**Data Source**: Lap Data

```typescript
{
  type: 'teammate_gap_summary_season',
  season: number,
  driver_primary_id: string,
  driver_secondary_id: string,
  team_id: string,
  gap_seconds: number,
  gap_seconds_abs: number,
  gap_pct: number,
  gap_pct_abs: number,
  shared_races: number,
  laps_considered: number,
  gap_band: string,
  coverage_status: CoverageStatus
}
```

**Trust Signals**: season, "Team-baseline normalized", "Lap data"

---

### 12. teammate_gap_dual_comparison

**Data Source**: Lap Data

```typescript
{
  type: 'teammate_gap_dual_comparison',
  season: number,
  driver_primary_id: string,
  driver_secondary_id: string,
  team_id: string,
  quali_gap_percent: number,
  race_gap_percent: number,
  quali_gap_seconds: number,
  race_gap_seconds: number,
  summary: DualComparisonSummary
}
```

---

### 13. track_fastest_drivers

**Data Source**: Lap Data

```typescript
{
  type: 'driver_ranking',
  season: number,
  track_id: string,
  metric: string,
  ranking_basis: 'lower_is_faster',
  entries: DriverRankingEntry[]
}
```

---

### 14. race_results_summary

**Data Source**: F1DB

```typescript
{
  type: 'race_results_summary',
  season: number,
  round: number,
  track_id: string,
  race_name: string,
  date: string,
  winner: string,
  winner_name: string,
  pole_sitter: string,
  fastest_lap: string,
  podium: string[],
  results: RaceResultsEntry[]
}
```

---

### 15. driver_pole_count

**Data Source**: F1DB

```typescript
{
  type: 'driver_pole_count',
  season: number,
  driver_id: string,
  pole_count: number,
  fastest_time_count: number,
  total_sessions: number,
  pole_rate_percent: number,
  front_row_count: number,
  top_3_count: number,
  avg_grid_position: number,
  best_grid_position: number,
  avg_qualifying_position: number,
  best_qualifying_position: number
}
```

---

### 16. driver_q3_count

**Data Source**: F1DB

```typescript
{
  type: 'driver_q3_count',
  season: number,
  driver_id: string,
  q3_count: number,
  q2_count: number,
  q1_eliminations: number,
  total_sessions: number,
  q3_rate_percent: number,
  avg_qualifying_position: number
}
```

---

### 17. season_q3_rankings

**Data Source**: F1DB

```typescript
{
  type: 'season_q3_rankings',
  season: number,
  rankings: Array<{
    driver_id: string,
    q3_count: number,
    total_sessions: number,
    q3_rate_percent: number
  }>
}
```

---

### 18. qualifying_gap_teammates

**Data Source**: Lap Data

```typescript
{
  type: 'qualifying_gap_teammates',
  season: number,
  team_id: string,
  driver_a_id: string,
  driver_b_id: string,
  gap_seconds: number,
  gap_percent: number,
  sessions_compared: number,
  driver_a_avg_position: number,
  driver_b_avg_position: number
}
```

---

### 19. qualifying_gap_drivers

**Data Source**: F1DB

```typescript
{
  type: 'qualifying_gap_drivers',
  season: number,
  driver_a_id: string,
  driver_b_id: string,
  driver_a_avg_position: number,
  driver_b_avg_position: number,
  position_gap: number,
  sessions_compared: number,
  driver_a_ahead_count: number,
  driver_b_ahead_count: number
}
```

---

## Frontend Implementation Status

All 19 query kinds are now fully visualized. Each visualization includes:

1. **Primary stat extraction**: Headline number/value using `queryRenderers` registry
2. **Trust signals**: Season, normalization type, and data source badges
3. **Expandable details**: Query-specific views (rankings, head-to-head, gap comparisons, etc.)
4. **Proper units**: Normalization-aware formatting (% for normalized, s for raw times)

### Specialized View Components

| View Component | Used By |
|---------------|---------|
| `RankingsView` | `track_fastest_drivers`, `season_q3_rankings`, `driver_multi_comparison` |
| `HeadToHeadView` | `driver_head_to_head_count`, `driver_matchup_lookup` |
| `SeasonComparisonView` | `season_driver_vs_driver` |
| `GapComparisonView` | `teammate_gap_summary_season`, `qualifying_gap_teammates`, `qualifying_gap_drivers` |
| `DualGapView` | `teammate_gap_dual_comparison` |
| Generic grid | All other query kinds |

### Fallback for Unknown Kinds

For any future query kinds not in `FRONTEND_SUPPORTED_KINDS`:
- `UnsupportedQueryDisplay` component shows:
  - "This query is supported by the API but not yet visualized"
  - Query type code
  - Collapsible raw JSON panel
