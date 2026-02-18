# F1Muse Documentation

## Overview

F1Muse is a natural language query API for Formula 1 statistics. It supports 24 query types across performance comparisons, career statistics, qualifying data, and race results.

## Blog

For methodology, architecture decisions, and implementation details, see the full write-up:
[Latency to Insight](https://tperm.bearblog.dev/latency-to-insight/)

---

## Supported Queries

### Performance Comparisons

These queries use lap-level telemetry from FastF1 (2018-2025). All pace values are session-median normalized percentages.

#### season_driver_vs_driver

Cross-team pace comparison for a full season.

**Example queries:**
- "Verstappen vs Norris 2024"
- "Compare Hamilton and Leclerc pace in 2023"
- "Who was faster, Alonso or Sainz in 2024?"

**Response includes:**
- Normalized pace for each driver
- Gap percentage
- Number of shared races
- Coverage status

---

#### cross_team_track_scoped_driver_comparison

Cross-team pace comparison at a specific circuit.

**Example queries:**
- "Verstappen vs Norris at Monaco 2024"
- "Hamilton vs Leclerc Silverstone pace 2023"

**Response includes:**
- Track-specific normalized pace
- Gap percentage
- Session count

---

#### teammate_gap_summary_season

Season-long pace gap between teammates. This is the primary metric for isolating driver skill from car performance.

**Example queries:**
- "Norris vs Piastri 2024"
- "Teammate gap Hamilton Russell 2023"
- "McLaren teammate battle 2024"

**Response includes:**
- Gap percentage (negative = first driver faster)
- Shared races count
- Qualifying gap vs race gap breakdown

---

#### teammate_gap_dual_comparison

Compares qualifying pace gap to race pace gap for the same teammate pair.

**Example queries:**
- "Compare qualifying vs race pace Norris Piastri 2024"
- "Where does Leclerc beat Sainz, qualifying or race?"

**Response includes:**
- Qualifying gap percentage
- Race pace gap percentage
- Session breakdown

---

#### track_fastest_drivers

Ranks all drivers by pace at a specific circuit.

**Example queries:**
- "Fastest drivers at Monaco 2024"
- "Who is quickest at Spa?"
- "Monza pace rankings 2023"

**Response includes:**
- Ranked list of drivers
- Normalized pace for each
- Gap to leader

---

#### driver_multi_comparison

Compare 2-6 drivers on a single metric within a season.

**Example queries:**
- "Compare Verstappen, Norris, and Leclerc race pace 2024"
- "Rank Hamilton, Russell, Sainz, Alonso by qualifying pace"
- "Who is faster between the top 4 drivers?"

**Response includes:**
- Ranked comparison
- Metric value for each driver
- Gap to leader

---

#### driver_vs_driver_comprehensive

Full comparison combining pace data with achievement stats.

**Example queries:**
- "Verstappen vs Norris full comparison 2024"
- "Complete head to head Leclerc Hamilton 2023"
- "Compare all stats Sainz vs Alonso 2024"

**Response includes:**
- Pace comparison
- Wins, podiums, poles, points
- Head-to-head qualifying count
- Head-to-head race finish count
- DNF counts

---

### Career and Season Statistics

These queries use official records from F1DB (1950-present).

#### driver_season_summary

Single driver statistics for a specific season.

**Example queries:**
- "Verstappen 2024 stats"
- "Hamilton season summary 2020"
- "How did Norris do in 2024?"

**Response includes:**
- Wins, podiums, poles
- Points, championship position
- DNFs, fastest laps

---

#### driver_career_summary

Career-spanning statistics for a driver.

**Example queries:**
- "Hamilton career stats"
- "Verstappen career summary"
- "Schumacher all-time statistics"

**Response includes:**
- Total wins, podiums, poles
- Championships
- Career points
- First/last race dates

---

#### driver_profile_summary

Comprehensive driver profile including performance trends.

**Example queries:**
- "Norris profile"
- "Tell me about Leclerc"
- "Verstappen driver summary"

**Response includes:**
- Career stats
- Best/worst tracks
- Latest season teammate gap
- Performance trend (last 3 seasons)

---

#### driver_trend_summary

Multi-season performance trend analysis.

**Example queries:**
- "Is Leclerc improving?"
- "Verstappen trend 2021-2024"
- "Hamilton performance over time"

**Response includes:**
- Slope per season (improvement/decline rate)
- Volatility measure
- Classification: improving, declining, or stable

---

#### driver_career_wins_by_circuit

Career wins breakdown by circuit.

**Example queries:**
- "Hamilton wins by circuit"
- "Where has Verstappen won?"
- "Schumacher circuit victories"

**Response includes:**
- List of circuits with win counts
- Last win year for each circuit
- Total career wins

---

#### driver_performance_vector

Cross-metric performance profile for a single season.

**Example queries:**
- "Norris performance profile 2024"
- "Verstappen strengths and weaknesses"
- "How consistent is Leclerc?"

**Response includes:**
- Qualifying percentile (0-100)
- Race pace percentile (0-100)
- Consistency score
- Street circuit delta
- Wet weather delta

---

### Head-to-Head Comparisons

Position-based comparisons (not pace-based).

#### driver_head_to_head_count

Counts how often one driver finished/qualified ahead of another.

**Example queries:**
- "How many times did Norris outqualify Piastri in 2024?"
- "Who finished ahead more often, Verstappen or Hamilton?"
- "Head to head Leclerc vs Sainz qualifying 2024"

**Supports filters:**
- Session (Q1, Q2, Q3)
- Track type (street, permanent)
- Weather (dry, wet, mixed)
- Specific rounds
- Exclude DNFs

**Response includes:**
- Win count for each driver
- Total comparable events
- Percentage

---

#### teammate_comparison_career

Multi-season teammate comparison with automatic season detection.

**Example queries:**
- "Hamilton vs Russell as teammates"
- "Norris vs Piastri all seasons"
- "Verstappen Ricciardo teammate history"

**Response includes:**
- Per-season breakdown
- Aggregated head-to-head counts
- Pace gaps per season

---

### Qualifying Statistics

#### qualifying_results_summary

Full qualifying grid with times and grid penalties.

**Example queries:**
- "Monaco 2024 qualifying results"
- "Who got pole at Silverstone 2023?"
- "Qualifying grid Monza 2024"

**Response includes:**
- Qualifying position (by time)
- Grid position (after penalties)
- Qualifying time / gap to pole
- Penalty details if applicable

---

#### driver_pole_count

Pole positions for a driver in a specific season.

**Example queries:**
- "How many poles did Verstappen get in 2024?"
- "Norris pole positions 2024"
- "Leclerc poles 2022"

**Response includes:**
- Pole count
- List of pole circuits

---

#### driver_career_pole_count

Career pole position count.

**Example queries:**
- "Hamilton career poles"
- "How many poles does Verstappen have?"
- "Schumacher total pole positions"

**Response includes:**
- Career pole count
- Pole percentage

---

#### driver_q3_count

Q3 appearances for a driver in a season.

**Example queries:**
- "How many times did Sainz make Q3 in 2024?"
- "Q3 appearances Hamilton 2023"
- "Albon Q3 count 2024"

**Response includes:**
- Q3 appearance count
- Total qualifying sessions
- Percentage

---

#### season_q3_rankings

Rank all drivers by Q3 appearances in a season.

**Example queries:**
- "Q3 rankings 2024"
- "Who made Q3 most often in 2023?"
- "Rank drivers by Q3 appearances"

**Response includes:**
- Ranked list of drivers
- Q3 count for each
- Total sessions

---

#### qualifying_gap_teammates

Qualifying time gap between teammates over a season.

**Example queries:**
- "Qualifying gap Norris vs Piastri 2024"
- "Who outqualified whom, Verstappen or Perez?"
- "Hamilton Russell qualifying gap 2023"

**Response includes:**
- Average gap (percentage)
- Head-to-head count
- Median gap

---

#### qualifying_gap_drivers

Qualifying position gap between any two drivers (cross-team).

**Example queries:**
- "Qualifying positions Verstappen vs Leclerc 2024"
- "Who qualifies higher, Norris or Hamilton?"

**Response includes:**
- Average position gap
- Head-to-head qualifying count

---

### Race Results

#### race_results_summary

Official race classification from F1DB.

**Example queries:**
- "Monaco 2024 results"
- "Who won Silverstone 2023?"
- "Monza race results 2024"

**Response includes:**
- Full classification
- Finishing positions
- Time gaps / laps down
- DNF reasons

---

## Data Coverage

| Source | Years | Volume | Use Case |
|--------|-------|--------|----------|
| FastF1 | 2018-2025 | ~161k laps | Pace analysis, telemetry |
| F1DB | 1950-2025 | ~243k results | Career stats, official records |

## Query Limits

- Driver multi-comparison: 2-6 drivers
- Trend analysis: Default 3 seasons, configurable
- Head-to-head filters: All optional, combinable

## Response Fields

All pace-based responses include:

| Field | Description |
|-------|-------------|
| `normalized_pace` | Session-median normalized percentage |
| `coverage_status` | `valid`, `low_coverage`, or `insufficient` |
| `shared_races` | Number of races included in comparison |
| `clean_air_only` | Whether traffic laps were filtered |

## Error Handling

Invalid queries return structured errors:

```json
{
  "error": "DRIVER_NOT_FOUND",
  "message": "Driver 'leclerk' not found. Did you mean 'leclerc'?",
  "suggestions": ["leclerc", "leclerc_sr"]
}
```

Common error codes:
- `DRIVER_NOT_FOUND`: Invalid driver name
- `SEASON_OUT_OF_RANGE`: Season not available (pace: 2018-2025, career: 1950-2025)
- `INSUFFICIENT_DATA`: Not enough laps/races for reliable comparison
- `INVALID_COMPARISON`: Drivers never raced in same season
