# F1Muse — Formula 1 Statistical Intelligence Engine

F1Muse is a natural language query engine for Formula 1 statistics and analysis. Ask questions in plain English—driver comparisons, race pace, historical stats—and get accurate, data-backed answers. The system uses normalized lap-level analysis, session-median pace deltas, and teammate-aware comparisons to produce meaningful results. Backed by official FIA timing data where applicable, with Redis caching and rate limiting built in for production use.

> **Note**: Lap-level pace data is available for 2018-2025 seasons. Career statistics (wins, poles, championships) cover the full modern era (1950-present).

## Methodology & Design

All pace comparisons use **session-median normalization**: each lap time is expressed as a percentage deviation from the session median, making metrics comparable across any track or session. A driver at -0.3% was three-tenths of a percent faster than the field—this holds whether it's Monaco or Monza.

Cross-team comparisons require shared races. Teammate analysis enforces that both drivers actually raced for the same team. Coverage thresholds (10+ valid laps per driver, 3+ shared sessions for season comparisons) prevent spurious results. The system rejects or warns on queries that don't meet these thresholds rather than returning misleading data.

**Data coverage by era:**
- **Pace-based analysis (2018-2025)**: Lap-level timing with clean air detection, enabling normalized pace comparisons
- **Position-based analysis (1950-present)**: Race results and finishing positions from F1DB for career H2H and historical queries

---

## What It Does

- **Driver vs driver comparisons** — Cross-team pace analysis with normalized lap time differentials
- **Teammate head-to-head** — Single season and career comparisons with race-by-race breakdowns
- **Wins by circuit** — Career victory counts at specific tracks
- **Race & qualifying pace analysis** — Pole counts, Q3 rates, grid position statistics
- **Historical summaries** — Career stats, season summaries, race results
- **Track-specific rankings** — Fastest drivers at any circuit in a given season

---

## Quickstart

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Redis (optional, for caching)
- Anthropic API key (for natural language parsing)

### Setup

```bash
git clone https://github.com/yourorg/f1muse.git
cd f1muse
npm install

# Configure environment
cp .env.example .env
```

Edit `.env` with your credentials:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/f1muse
ANTHROPIC_API_KEY=sk-ant-...
REDIS_URL=redis://localhost:6379  # optional
```

### Run Locally

```bash
npm run dev
```

The API starts on `http://localhost:3000`.

### Test a Query

```bash
curl -X POST http://localhost:3000/nl-query \
  -H "Content-Type: application/json" \
  -H "User-Agent: f1muse-test" \
  -d '{"question": "verstappen vs norris 2024"}'
```

---

## Example Queries

| Query | Returns |
|-------|---------|
| `"Verstappen vs Norris 2024"` | Season pace comparison with normalized differential *(lap data: 2018-2025)* |
| `"Hamilton wins by circuit"` | Career victory count at each track *(full career from F1DB)* |
| `"Alonso 2024 season summary"` | Wins, podiums, points, best finish |
| `"Hamilton vs Russell as teammates"` | Head-to-head pace delta across shared races *(lap data: 2018-2025)* |
| `"Fastest drivers at Monaco 2024"` | Ranked list by normalized pace *(lap data: 2018-2025)* |
| `"Leclerc pole count 2024"` | Poles, front rows, Q3 rate, average grid |

The system handles driver name variations (`VER`, `Verstappen`, `max verstappen`) and track aliases (`Monaco`, `Monte Carlo`).

---

## Architecture Overview

```
Question → Intent Parser (Claude) → SQL Template Selection → PostgreSQL → Formatter → Response
```

1. **Intent parsing**: Natural language is converted to a structured query intent via Claude API
2. **Validation**: Semantic rules enforce constraints (teammates must share a team, seasons must exist, etc.)
3. **Template execution**: Pre-approved SQL templates run against the database—no dynamic SQL generation
4. **Formatting**: Results are enriched with confidence scores, sample sizes, and methodology notes
5. **Caching**: Redis stores results with TTLs based on data volatility (5 min for current season, 1 hour for historical)

### Production Hardening

- **Rate limiting**: Redis-backed with burst protection (120 req/min, 40 req/10s burst)
- **Bot protection**: Blocks known automation UAs, requires User-Agent header
- **Emergency kill switch**: Set `DISABLE_NL_QUERY=true` to disable the endpoint without redeploying
- **Graceful degradation**: Falls back to in-memory rate limiting if Redis is unavailable

---

## Supported Query Types

| Category | Type | Description |
|----------|------|-------------|
| **Comparisons** | `season_driver_vs_driver` | Cross-team pace comparison |
| | `cross_team_track_scoped_driver_comparison` | Track-specific comparison |
| | `track_fastest_drivers` | Ranked driver list at a circuit |
| **Teammate** | `teammate_gap_summary_season` | Season-long teammate gap |
| | `teammate_comparison_career` | Career head-to-head |
| **Qualifying** | `driver_career_pole_count` | Pole position statistics |
| | `qualifying_results_summary` | Session results |
| **Summaries** | `driver_career_summary` | Career statistics |
| | `driver_season_summary` | Single season stats |
| | `race_results_summary` | Official race results |
| | `driver_career_wins_by_circuit` | Wins at each track |

---

## Data Sources

**Lap Timing ([FastF1](https://docs.fastf1.dev/))**: Session-by-session lap times for 2018-2025 seasons (~161,000 laps). Individual lap times with validity flags, batch ingested after each race weekend. Clean air detection uses gap-to-leader data for 2022+ seasons; for 2018-2021, gaps are calculated from cumulative lap times (FastF1 limitation—no real-time gap data for older seasons).

**Official Records ([F1DB](https://github.com/f1db/f1db))**: Career statistics, race results, qualifying positions, and championship standings from official FIA records spanning 1950-present (~243,000 race entries).

---

## Non-Goals

- **Not real-time telemetry** — Data is ingested post-session, not live
- **Not a betting tool** — No odds, predictions, or gambling features
- **Not a fantasy optimizer** — No lineup recommendations or points projections
- **Not official** — Independent analysis tool, not affiliated with F1/FIA

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for NL parsing |
| `REDIS_URL` | No | Redis for caching and rate limiting |
| `DATABASE_URL_REPLICA` | No | Read replica for scaling |
| `STRICT_INVARIANTS` | No | Throw on data quality issues |
| `DISABLE_NL_QUERY` | No | Emergency kill switch |

---

## License & Disclaimer

MIT License. See [LICENSE](LICENSE) for details.

Timing data sourced from [FastF1](https://docs.fastf1.dev/). Historical records from [F1DB](https://github.com/f1db/f1db). This project is not affiliated with Formula 1, the FIA, or any teams or drivers. All trademarks belong to their respective owners.
