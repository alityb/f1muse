# F1Muse

**Ask questions about F1 in plain English. Get accurate, data-backed answers.**

F1Muse is an AI-powered F1 analytics platform that transforms natural language questions into precise statistical analysis. No spreadsheets. No manual lookups. Just ask.

[Live Demo](https://f1muse.com) · [API Documentation](#api-reference) · [How It Works](#how-it-works)

---

## Features

### Natural Language Queries
Ask questions the way you'd ask a friend:
- *"Who's faster, Verstappen or Norris?"*
- *"How big is the gap between Leclerc and Sainz?"*
- *"Fastest drivers at Monaco this year"*

### Cross-Team Comparisons
Compare any two drivers regardless of team. Our session-median normalization makes pace comparable across different cars and tracks.

### Teammate Analysis
See the real gap between teammates with race-by-race breakdowns, qualifying vs race pace splits, and season-long trends.

### Qualifying Deep Dives
Pole counts, Q3 appearance rates, qualifying head-to-heads, and grid position analysis for any driver or season.

### Career & Historical Data
Championships, wins, podiums, and career trajectories powered by official F1DB records spanning the entire modern era.

### Trust Signals
Every answer shows its data source, sample size, and confidence level. You always know exactly what the numbers mean.

---

## Example Queries

| Question | What You Get |
|----------|--------------|
| "Verstappen vs Norris 2024" | Season pace comparison with normalized lap time differential |
| "Leclerc vs Sainz teammate gap 2024" | Race-by-race pace delta across 24 races |
| "Fastest drivers at Monaco 2024" | Ranked driver list by normalized pace at that circuit |
| "Hamilton career summary" | Championships, wins, podiums, seasons raced |
| "Verstappen pole count 2024" | Poles, front rows, Q3 rate, average grid position |
| "Monaco 2024 race results" | Official finishing order with grid positions |

---

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Your Question  │ ──▶ │   AI Parser     │ ──▶ │  Validated SQL  │
│  "VER vs NOR"   │     │  (Claude API)   │     │  (No injection) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Visual Answer  │ ◀── │   Formatting    │ ◀── │   PostgreSQL    │
│  + Trust Signals│     │   + Confidence  │     │   (Lap Data)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Parse**: Your question is converted to a structured query intent by Claude
2. **Validate**: The intent is checked against semantic rules (teammates must share a team, etc.)
3. **Execute**: Pre-approved SQL templates run against our PostgreSQL database
4. **Format**: Results are enriched with confidence scores and methodology notes
5. **Display**: Clean visualizations with transparent data sourcing

**No dynamic SQL generation. No hallucination. Every query runs against validated templates.**

---

## Data Sources

### Lap Timing Data (FastF1)
Session-by-session lap times for every driver at every race. Normalized to session median for cross-track comparability.

- **Coverage**: 2024-2025 seasons (48 races, 100% complete)
- **Granularity**: Individual lap times with validity flags
- **Updates**: Batch ingested after each race weekend

### Official Records (F1DB)
Career statistics, race results, qualifying positions, and championship standings from the official F1 database.

- **Coverage**: Complete modern era
- **Source**: Official FIA records
- **Includes**: Grid penalty corrections, DNS handling, sprint results

---

## Technical Highlights

### Session-Median Normalization
Raw lap times are meaningless across tracks. A 75-second Monaco lap isn't comparable to an 82-second Monza lap. We normalize each lap as a percentage deviation from the session median:

```
normalized = ((lap_time - session_median) / session_median) × 100
```

A driver at **-0.3%** was three-tenths of a percent faster than the field. This metric is comparable across any track, any session.

### Coverage Thresholds
Not all data is equal. We enforce minimums:
- **10+ valid laps** per driver for pace calculations
- **3+ shared sessions** for season comparisons
- **20+ laps** for session median calculations

Queries below these thresholds show warnings or return insufficient coverage errors.

### Strict Mode
Set `STRICT_INVARIANTS=true` to make the API throw on any data quality issue rather than returning partial results. Recommended for production integrations.

---

## API Reference

### Natural Language Query

```bash
POST /nl-query
Content-Type: application/json

{
  "question": "verstappen vs norris 2024"
}
```

**Response:**
```json
{
  "query_kind": "season_driver_vs_driver",
  "result": {
    "driver_a": "max_verstappen",
    "driver_b": "lando_norris",
    "difference": -0.127,
    "normalization": "session_median_percent",
    "shared_races": 24,
    "laps_considered": 2456
  }
}
```

### Health Check

```bash
GET /health
```

### Supported Query Types

```bash
GET /capabilities
```

---

## Self-Hosting

### Prerequisites
- Node.js 20+
- PostgreSQL 14+
- Anthropic API key

### Quick Start

```bash
git clone https://github.com/yourorg/f1muse.git
cd f1muse
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL and ANTHROPIC_API_KEY

# Start the API
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | Claude API key for NL parsing |
| `DATABASE_URL_REPLICA` | No | Read replica for scaling |
| `REDIS_URL` | No | Redis for query caching |
| `STRICT_INVARIANTS` | No | Throw on data quality issues |

### Frontend

```bash
cd "Figma frontend"
npm install
npm run dev
# Opens at http://localhost:5173
```

---

## Supported Query Types

| Category | Query Type | Description |
|----------|------------|-------------|
| **Comparisons** | `season_driver_vs_driver` | Cross-team pace comparison |
| | `cross_team_track_scoped_driver_comparison` | Track-specific comparison |
| | `track_fastest_drivers` | Ranked driver list at a circuit |
| **Teammate Analysis** | `teammate_gap_summary_season` | Season-long teammate gap |
| | `teammate_gap_dual_comparison` | Qualifying vs race pace split |
| **Qualifying** | `driver_pole_count` | Pole position statistics |
| | `driver_q3_count` | Q3 appearance rate |
| | `season_q3_rankings` | Season Q3 leaderboard |
| | `qualifying_gap_teammates` | Teammate qualifying delta |
| | `qualifying_gap_drivers` | Cross-team qualifying comparison |
| **Summaries** | `driver_career_summary` | Career statistics |
| | `driver_season_summary` | Single season stats |
| | `race_results_summary` | Official race results |

---

## Architecture

```
f1muse/
├── src/
│   ├── api/           # Express routes & middleware
│   ├── execution/     # Query orchestration & formatting
│   ├── identity/      # Driver & track name resolution
│   ├── llm/           # Claude integration
│   └── types/         # TypeScript definitions
├── templates/         # Pre-approved SQL templates
└── Figma frontend/    # React UI
```

---

## Roadmap

- [ ] Tire strategy analysis
- [ ] Weather-adjusted pace
- [ ] Constructor comparisons
- [ ] Historical season support (pre-2024)
- [ ] Real-time race weekend updates

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

Before adding new query types, read the [Query Contract](docs/QUERY_CONTRACT.md) to understand the end-to-end implementation requirements.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Built for F1 fans who want real answers, not guesses.</strong>
</p>
