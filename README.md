<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
    <img alt="F1Muse" src=".github/logo.svg" width="280">
  </picture>
</p>

<p align="center">
  <strong>Formula 1 Query Engine</strong><br>
  Ask questions in plain English. Get data-backed answers.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#example-queries">Examples</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#supported-queries">Query Types</a>
</p>

---

F1Muse is a natural language query engine for Formula 1 statistics. Ask questions about driver comparisons, race results, qualifying performance, and career statistics—the system parses your question, selects the appropriate SQL template, and returns accurate, formatted answers.

> **Data coverage**: Lap-level pace data for 2018-2025 seasons. Career statistics and race results from 1950-present via F1DB.

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

| Query | What it returns |
|-------|-----------------|
| `"Verstappen vs Norris 2024"` | Season pace comparison with normalized differential |
| `"Hamilton wins by circuit"` | Career victory count at each track |
| `"Alonso 2024 season summary"` | Wins, podiums, points, best finish |
| `"Hamilton vs Russell as teammates"` | Head-to-head across all shared seasons |
| `"Fastest drivers at Monaco 2024"` | Ranked list by normalized pace |
| `"Leclerc pole count 2024"` | Pole positions in the season |
| `"Results Monaco 2024"` | Official race results with positions |
| `"Qualifying results Bahrain 2024"` | Full qualifying grid and times |
| `"Head to head Norris vs Piastri"` | Position-based comparison (who finished ahead) |

The system handles driver name variations (`VER`, `Verstappen`, `max verstappen`) and track aliases (`Monaco`, `Monte Carlo`).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              F1Muse Architecture                             │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────┐      ┌────────────────┐      ┌────────────────┐      ┌─────────────┐
  │   User   │─────▶│    Frontend    │─────▶│   API Server   │─────▶│  Claude API │
  │          │      │   (Next.js)    │      │   (Express)    │      │  (Anthropic)│
  └──────────┘      │    Vercel      │      │    Railway     │      │             │
       │            └────────────────┘      └───────┬────────┘      └──────┬──────┘
       │                                           │                       │
       │            "verstappen vs norris"         │                       │
       └───────────────────────────────────────────┘                       │
                                                                          │
                                    ┌──────────────────────────────────────┘
                                    │  { kind: "season_driver_vs_driver",
                                    │    driver_a_id: "max-verstappen",
                                    │    driver_b_id: "lando-norris" }
                                    ▼
                    ┌───────────────────────────────────────┐
                    │         Execution Pipeline            │
                    │                                       │
                    │  Parse → Validate → Template Select   │◀──┐
                    │          → Execute → Format           │   │
                    └───────────────────┬───────────────────┘   │
                                        │                       │
                         ┌──────────────┼──────────────┐        │
                         │              │              │        │
                         ▼              ▼              ▼        │
                   ┌──────────┐  ┌────────────┐  ┌─────────┐    │
                   │   SQL    │  │  PostgreSQL │  │  Redis  │───┘
                   │ Templates│  │  (Supabase) │  │  Cache  │
                   │          │  │             │  │         │
                   │ 27 types │  │ F1DB + Laps │  │ TTL-    │
                   │ approved │  │ 1950-2025   │  │ based   │
                   └──────────┘  └─────────────┘  └─────────┘
```

### Pipeline Steps

1. **Parse**: Claude API converts natural language to structured QueryIntent
2. **Validate**: Semantic rules enforce constraints (teammates must share team, seasons must exist)
3. **Template Select**: Maps intent kind to pre-approved SQL template
4. **Execute**: Runs parameterized SQL against PostgreSQL
5. **Format**: Enriches results with confidence scores and methodology notes

### Production Features

- **Rate limiting**: Redis-backed with burst protection (120 req/min)
- **Bot protection**: Blocks automation UAs, requires User-Agent header
- **Kill switch**: Set `DISABLE_NL_QUERY=true` to disable endpoint
- **Graceful degradation**: Falls back to in-memory rate limiting if Redis unavailable

---

## Supported Queries

### Comparisons

| Type | Description | Example |
|------|-------------|---------|
| `season_driver_vs_driver` | Cross-team pace comparison | "Verstappen vs Norris 2024" |
| `cross_team_track_scoped_driver_comparison` | Track-specific comparison | "Leclerc vs Sainz at Monaco 2024" |
| `track_fastest_drivers` | Ranked driver list at circuit | "Fastest drivers Silverstone 2024" |
| `driver_multi_comparison` | Compare 2-6 drivers | "Compare Verstappen, Norris, Leclerc" |
| `driver_head_to_head_count` | Position-based head-to-head | "Head to head Norris vs Piastri" |
| `driver_vs_driver_comprehensive` | Full comparison (pace + stats) | "Complete comparison Hamilton Russell" |

### Teammate Analysis

| Type | Description | Example |
|------|-------------|---------|
| `teammate_gap_summary_season` | Season-long teammate gap | "Norris vs Piastri gap 2024" |
| `teammate_gap_dual_comparison` | Qualifying vs race gap | "McLaren teammate gap qualifying vs race" |
| `teammate_comparison_career` | Multi-season teammate H2H | "Hamilton vs Russell as teammates" |

### Qualifying

| Type | Description | Example |
|------|-------------|---------|
| `qualifying_results_summary` | Full qualifying grid | "Qualifying results Monaco 2024" |
| `driver_pole_count` | Season pole positions | "Verstappen poles 2024" |
| `driver_career_pole_count` | Career pole positions | "Hamilton career poles" |
| `driver_q3_count` | Q3 appearances | "Sainz Q3 count 2024" |
| `season_q3_rankings` | Ranked by Q3 appearances | "Q3 rankings 2024" |
| `qualifying_gap_teammates` | Teammate qualifying gap | "Qualifying gap Norris Piastri" |

### Results & Summaries

| Type | Description | Example |
|------|-------------|---------|
| `race_results_summary` | Official race results | "Results Monaco 2024" |
| `driver_season_summary` | Single season stats | "Alonso 2024 summary" |
| `driver_career_summary` | Career statistics | "Vettel career stats" |
| `driver_career_wins_by_circuit` | Wins at each track | "Hamilton wins by circuit" |
| `driver_profile_summary` | Comprehensive profile | "Verstappen profile" |
| `driver_trend_summary` | Performance trend | "Is Leclerc improving?" |

---

## Methodology

### Pace Normalization

All pace comparisons use **session-median normalization**: each lap time is expressed as a percentage deviation from the session median. A driver at -0.3% was three-tenths of a percent faster than the field—comparable across any track.

### Coverage Thresholds

- Cross-team comparisons require shared races
- Teammate analysis enforces same-team constraint
- Minimum 10 valid laps per driver for pace metrics
- Minimum 3 shared sessions for season comparisons

The system rejects or warns on queries that don't meet thresholds rather than returning misleading data.

### Data Eras

| Era | Data Available |
|-----|----------------|
| **1950-2017** | Race results, qualifying positions, career stats (F1DB) |
| **2018-2025** | Above + lap-level timing with clean air detection (FastF1) |

---

## Data Sources

**[FastF1](https://docs.fastf1.dev/)**: Session-by-session lap times for 2018-2025 (~161,000 laps). Individual lap times with validity flags.

**[F1DB](https://github.com/f1db/f1db)**: Official FIA records spanning 1950-present (~243,000 race entries). Career statistics, race results, qualifying positions.

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

## Non-Goals

- **Not real-time telemetry** — Data is ingested post-session
- **Not a betting tool** — No odds, predictions, or gambling features
- **Not a fantasy optimizer** — No lineup recommendations
- **Not official** — Independent analysis, not affiliated with F1/FIA

---

## License

MIT License. See [LICENSE](LICENSE) for details.

Timing data from [FastF1](https://docs.fastf1.dev/). Historical records from [F1DB](https://github.com/f1db/f1db). Not affiliated with Formula 1, the FIA, or any teams/drivers.
