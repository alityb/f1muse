# Latency to Insight (F1Muse)

**13 Feb, 2026**

I always wanted a go-to place for F1 statistics. Every other alternative seemed out-dated and didn't really have a compelling UX. A lot of the current F1 websites have the same format: search for driver/race track → look at basic statistics. I wanted to combine the both into a single website, and the best solution looked like Statmuse. The great part of the UX is it allows twitter fans to get statistics in a second for their 50 tweet-long threads, but it is only available for a few sports. So the solution is to make an F1-equivalent!

## The Problem Space

F1 data is messy. Like, really messy. You've got FIA timing screens that show one thing, official results that show another, and telemetry data that tells a completely different story. And then there's the question of what actually matters—is a driver fast because they're good, or because their car is good? How do you compare Verstappen in a Red Bull to Alonso in an Aston Martin?

Most F1 stats sites just show you lap times and positions. Cool, Hamilton did a 1:31.2 at Silverstone. But what does that *mean*? Is that fast? Was he in traffic? Did he have a 20-lap old tire?

The real insight comes from asking questions like "who's faster between teammates?" or "how did Verstappen's 2024 compare to Norris?" And you want answers in seconds, not after clicking through five pages of tables.

## Architecture: From RAG to Intent Parsing

### The RAG Experiment

Initially, I thought RAG (Retrieval Augmented Generation) would work. Load the F1 database into a vector store, let the LLM query it directly. The LLM would understand the question, retrieve relevant context, and generate an answer.

Turns out that's expensive. Really expensive. Every query hits the LLM with massive context windows (thousands of tokens for race data), and Claude API charges per token. For a query like "Verstappen vs Norris 2024", you'd be sending 161,000+ lap records as context. Even with chunking and semantic search, the cost was $0.05-0.10 per query. That doesn't scale.

### The Statmuse Insight

Then I noticed something about Statmuse: every answer had an "interpreted as:" line showing how it understood the query. That's when it clicked—you don't need the LLM to generate the answer, just to **parse the intent**. Once you know what the user wants (driver comparison, season 2024, these two drivers), you can execute a deterministic SQL query.

### The Two-Tier Design

So F1Muse uses a two-tier architecture:

```
User Question ("verstappen vs norris 2024")
    ↓
Claude API (parse to structured JSON)
    ↓
Validation Layer (semantic rules, schema checks)
    ↓
Execution Layer (pre-approved SQL templates only)
    ↓
PostgreSQL (read-only queries)
```

The LLM converts natural language into a `QueryIntent` object—structured JSON that says "this is a season_driver_vs_driver comparison for 2024 with these two drivers." Then the validation layer checks: Do these drivers exist? Did they race in 2024? Is this query type valid?

Only after passing validation does it hit one of 27 pre-approved SQL templates. The LLM is creative, the API is paranoid. The cost is ~$0.001 per query (just the intent parsing). That's 50-100x cheaper than RAG.

## Data Sources

### FastF1 (2018-2025)
Lap-level telemetry. Every lap, every driver, every session. This is where the pace data comes from—161,000+ laps parsed from FIA timing screens.

### F1DB (1950-present)
Official historical records. Race results, qualifying grids, career stats. This is the "official" data—243,000+ race entries going back to the 1950s.

### The Two-ID Problem

These datasets use completely different ID systems. FastF1 uses `monaco_grand_prix`, F1DB uses `monaco`. Driver names don't match. Team names change every year.

Solution: Use `(season, round)` as the join key instead of track IDs. Every race has a unique (season, round) pair, and both FastF1 and F1DB use this consistently. The `TrackResolver` converts user input (track name) to `(season, round)`, and all queries use that tuple.

## Pace Normalization

### The Problem
Monaco lap times are ~1:12, Monza lap times are ~1:21. You can't compare raw lap times across circuits. You also can't compare lap times across teams—of course Verstappen is faster than Sargeant, his car is better.

### Session-Median Normalization
For every lap, calculate:

```
gap_percent = (driver_time - session_median) / ((driver_time + session_median) / 2) * 100
```

Now every lap is a percentage deviation from the field. A driver at -0.3% was three-tenths-of-a-percent faster than the median—whether that's at Monaco or Monza. Verstappen's -0.7% at Circuit of the Americas is directly comparable to Norris's -0.5% at Silverstone.

This is the core metric for all cross-team comparisons. It's not perfect (track evolution, tire deg, fuel load all matter), but it's comparable.

## Teammate Gaps

The cleanest way to measure driver skill is teammate comparison. Same car, same strategy (usually), same weekend. If you want to know if a driver is actually fast or just has a good car, compare them to their teammate.

F1Muse has a whole subsystem for this. The SQL template looks like:

```sql
-- Filter to shared laps (same session, both drivers on track)
-- Exclude pit laps, in-laps, out-laps
-- Calculate median lap times for each driver
-- gap_percent = 100 * (primary - secondary) / ((primary + secondary) / 2)
```

The result is a percentage gap across the full season. Negative means the first driver is faster. For example, in 2024:

- Norris vs Piastri: -0.15% (Norris faster by about a tenth and a half)
- Leclerc vs Sainz: -0.22% (Leclerc ahead)
- Verstappen vs Perez: -0.68% (oof)

This is the most reliable performance metric in F1Muse because it isolates driver skill from car performance.

## Clean Air Detection

Lap times in traffic are meaningless. If you're stuck behind someone, you're going slower—not because you're slow, but because you're in dirty air. So F1Muse has a `clean_air_flag` on every lap.

The algorithm is simple: if the gap to the car ahead is below a threshold, mark it as traffic. Otherwise, clean air. The threshold is 2.0 seconds for 2018-2024 seasons, but 1.5 seconds for 2025 (adjusted for closer racing with the new regulations).

When you ask for "true pace" comparisons, F1Muse filters to clean air laps only. Otherwise you're comparing someone's qualifying sim to someone else's traffic stint.

During the ETL process, about 30-40% of laps get filtered out for being in traffic. The remaining laps are the "representative" pace data.

## Identity Resolution

### Strict Literal Matching

F1Muse uses strict literal matching only. No fuzzy matching, no Levenshtein distance, no "did you mean...?" The resolver does:

1. Normalize the input (lowercase, strip diacritics)
2. Look for exact matches (case-insensitive)
3. If multiple matches, rank by:
   - Season participation (did they race this year?)
   - Teammate context (are they on the right team?)
   - Coverage score (do they have lap data?)
4. If ambiguous, fail

Better to fail than to guess wrong. This is stricter than most search engines, but it prevents hallucinations. The LLM can be creative, the identity resolver is paranoid.

## Query Types

F1Muse supports 24 different query types, implemented via 27 SQL templates (some query types have multiple template variations).

### Performance Comparisons
- `season_driver_vs_driver`: Cross-team pace comparison (Verstappen vs Norris)
- `teammate_gap_summary_season`: Season-long teammate battle
- `track_fastest_drivers`: Who's fastest at this circuit?

### Career Stats
- `driver_career_summary`: Career wins, podiums, championships
- `driver_career_wins_by_circuit`: Hamilton has 8 wins at Silverstone, etc.
- `driver_trend_summary`: Is this driver improving over time?

### Qualifying
- `qualifying_results_summary`: Full qualifying grid with times
- `driver_pole_count`: Pole positions in a season
- `qualifying_gap_teammates`: Qualifying pace vs teammate

### Race Results
- `race_results_summary`: Official race results (from F1DB)
- `driver_season_summary`: Wins, podiums, points for a season

Each query type maps to one or more versioned SQL templates. The API never generates SQL—it just selects the right template and binds parameters.

## The Three-Layer Cache

F1Muse has a three-layer cache architecture, and it's probably the most important part of the system.

### Why Caching Matters

**Problem 1:** Claude API calls cost money and take ~800ms-2s. If every user query hits the LLM, latency is terrible and costs scale linearly with traffic.

**Problem 2:** SQL queries on 161,000+ laps are expensive. Session-median normalization requires sorting, aggregations, and joins across multiple tables. Even with indexes, these queries take 100-300ms.

**Problem 3:** Users ask the same questions repeatedly. "Verstappen vs Norris 2024" probably gets asked 50 times a day. Running the same computation 50 times is wasteful.

**Solution:** Cache everything, at multiple layers.

### Layer 1: Intent Cache (LLM Translation Cache)

The first layer caches **LLM translations**. When you ask "verstappen vs norris 2024", Claude converts that to a `QueryIntent` JSON object. That translation gets stored in Redis (or Postgres as fallback) with the normalized question as the key.

**The trick:** Aggressive normalization increases cache hits. The intent cache:
- Removes stopwords ("the", "is", "what", etc.)
- Strips punctuation
- Collapses whitespace
- Lowercases everything

So these all map to the same cache key:
- "What is the gap between Verstappen and Norris in 2024?"
- "verstappen vs norris 2024"
- "gap verstappen norris 2024"
- "Show me Verstappen Norris 2024"

The normalized form is `gap verstappen norris 2024`, and they all hit the same cached intent.

**TTL strategy:**
- Current season (2025): 1 hour (queries might be refined as data evolves)
- Past seasons: 24 hours (historical data doesn't change)

This avoids ~80% of LLM calls in production. Cache hit rate is typically 75-85% depending on query diversity.

### Layer 2: Query Cache (SQL Results Cache)

The second layer caches **SQL results**. After executing a query, the result is stored in Postgres (or Redis) with a hash of the query parameters as the key.

This cache has a shorter TTL because F1 data changes:
- Current season (2025): 5 minutes (race weekends need fresh data)
- Historical queries: 1 hour (data rarely changes, but still want some freshness)
- Career queries: 1 hour (lifetime stats don't change often)

The cache key includes:
- Query type (e.g., `season_driver_vs_driver`)
- All parameters (season, driver IDs, normalization strategy)
- Cache version (`v2`, bumped when SQL templates change)

**Why Postgres for caching?** Redis is optional in F1Muse. If Redis is unavailable (which happens—Redis restarts, network issues, memory pressure), the system falls back to Postgres. The query cache is stored in a dedicated `query_cache` table with a `cached_at` timestamp. A background job cleans up stale entries every hour.

This means the system works fine without Redis. You lose some speed (Postgres is slower than Redis for cache lookups), but it doesn't break.

### Layer 3: Redis Cache (In-Memory Layer)

The third layer is **Redis** for speed. Redis lookups are ~1-2ms vs ~10-20ms for Postgres. For high-traffic queries, this matters.

Redis configuration:
- Connection pooling with 3 retry attempts
- 5-second connection timeout (fail fast if Redis is down)
- 1-second operation timeout (don't wait forever)
- Automatic reconnection with exponential backoff

**Graceful degradation:** If Redis is unavailable, the cache layer automatically falls back to Postgres. The API doesn't crash, it just gets slower. This is critical for production—you want Redis for speed, but you don't want a hard dependency.

### Cache Performance

Example flow for a cache hit:
```
1. User asks "verstappen vs norris 2024"
2. Normalize question → "verstappen norris 2024"
3. Check intent cache (Redis) → HIT (2ms)
4. Extract QueryIntent JSON
5. Generate query cache key → hash(season_driver_vs_driver, 2024, verstappen, norris, ...)
6. Check query cache (Redis) → HIT (2ms)
7. Return cached result
Total latency: ~10ms (vs 2000ms without cache)
```

Example flow for a cache miss:
```
1. User asks "leclerc vs sainz monaco 2024"
2. Normalize question → "leclerc sainz monaco 2024"
3. Check intent cache (Redis) → MISS
4. Call Claude API → 1200ms
5. Store intent in cache (TTL: 1h)
6. Generate query cache key
7. Check query cache (Redis) → MISS
8. Execute SQL query → 180ms
9. Store result in cache (TTL: 1h)
10. Return result
Total latency: ~1400ms (but next query is 10ms)
```

### Cache Invalidation

Cache invalidation is famously one of the two hard problems in computer science. F1Muse uses **versioned cache keys** to handle this.

Every cache key includes a version:
- Intent cache: `v5` (bumped when query types change)
- Query cache: `v2` (bumped when SQL templates change)

When you deploy a new version that changes how queries work, bump the version. All old cache entries are now orphaned (wrong version prefix) and will eventually expire. No need to manually flush the cache.

### Why This Matters

Without caching, F1Muse would be unusable:
- Every query hits Claude API: 2 seconds latency, $0.01 per query
- Every query runs SQL: 200ms+ per query, high database load
- 100 users asking the same question = 100 identical computations

With caching:
- 80% of queries skip the LLM: 10ms latency, negligible cost
- 90% of queries skip SQL: 2-5ms latency, minimal database load
- 100 users asking the same question = 1 computation, 99 cache hits

Caching reduces latency by **100-200x** and cost by **10-20x**. It's not optional—it's the difference between a functional product and an expensive science experiment.

## Data Quality

The ETL pipeline is paranoid. Every ingestion job:

1. Validates schema before inserting
2. Checks for duplicate races (idempotent)
3. Requires minimum lap counts (10+ valid laps per driver)
4. Logs an `execution_hash` for audit trails
5. Runs in transactions (rollback on failure)

If FastF1 returns garbage data, the ingestion fails. No partial inserts, no "close enough" data. The principle is: **fail closed on data quality issues**.

The ingestion script has comments like:

```python
# SAFETY-CRITICAL ETL JOB
# Rules:
# - Manual execution only
# - One-shot, deterministic
# - Fail-closed on any data quality issue
# - Transactional (per race)
```

This isn't a startup that can afford to show users wrong data and say "oops, we're in beta." F1 fans *will* notice if the numbers are wrong.

## Qualifying Data

### The Grid Penalty Problem

Qualifying data is a nightmare. Here's why:

1. FIA applies grid penalties *after* qualifying
2. Multiple drivers can get knocked out in Q1/Q2
3. "Qualifying position" (by time) ≠ "grid position" (official start)

Example: Driver qualifies P5, gets a 10-place penalty, starts P15. Which number do you show?

F1Muse has a `qualifying_grid_corrections` table that tracks FIA penalties. The `qualifying_results_summary` template joins this table to show both:
- Qualifying position (by time)
- Official grid position (post-penalties)

Now users can see: "Sainz qualified P5 (1:29.345) but started P15 (grid penalty)". Makes it clear when penalties were applied and avoids confusion.

## Production Features

### Emergency Kill Switch
`DISABLE_NL_QUERY=true` instantly disables the natural language endpoint without redeploying. If Claude API goes down or starts hallucinating, flip the switch.

### Rate Limiting
120 requests/minute with burst protection. Redis-backed, but falls back to in-memory if Redis is unavailable. Bot User-Agents get blocked.

### Timeouts
15 seconds for `/nl-query` requests (accounts for Claude API latency). If it takes longer than that, something is wrong.

### Observability
Prometheus metrics for latency, error rates, cache hit ratios, LLM concurrency pressure. Every query is instrumented.

## What's Next?

Current status: 2018-2025 lap data is loaded (161,000+ laps). Historical career stats go back to 1950. The API is stable, caching works, LLM parsing is reliable.

Some things I want to add:

### Stint Analysis
Compare drivers on the same tire compound. Right now F1Muse aggregates across the whole race, but stint-by-stint analysis would be more granular.

### Qualifying Pace
The current focus is race pace, but qualifying has different dynamics (tire prep, track evolution, traffic). Separate methodology needed.

### Front-end
Right now it's just an API. A Statmuse-style web UI would make it more accessible.

### Multi-Season Trends
Track how a driver's performance evolves over multiple years. Is Leclerc improving? Is Verstappen declining?

### Tire Degradation
Compare how drivers manage tire wear over a stint. Some drivers are fast on lap 1, some are fast on lap 20.

## The Point

F1Muse isn't trying to be the next Autosport or the-race.com. It's trying to answer specific questions fast. "Who's faster between teammates?" should take 2 seconds, not 20 minutes of spreadsheet work.

The architecture is paranoid because F1 data is messy and LLMs are creative. The validation layer is strict because showing wrong data is worse than showing no data. The pace normalization is imperfect but comparable, which is better than precise but incomparable.

If you want to know who won the 2024 Monaco GP, use Wikipedia. If you want to know who was actually *faster* at Monaco across the whole season, accounting for traffic and tire deg and team performance, that's what F1Muse is for.

---

**Tech Stack:** Node.js, TypeScript, PostgreSQL, Redis, Claude API (Anthropic SDK)
**Data Sources:** FastF1 (lap telemetry 2018-2025), F1DB (official records 1950-present)
**Code:** [github.com/alityb/f1muse](https://github.com/alityb/f1muse) (if public, otherwise remove this line)
**Deployed on:** Railway (Kubernetes-compatible health checks, graceful shutdown, environment-based config)

_Not affiliated with Formula 1, FIA, or any teams. Just a fan with a database and too much free time._
