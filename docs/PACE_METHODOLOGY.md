# Pace Methodology

F1QL pace methodology version: `clean_air_gap_2_0s_v1`.

- Source: `laps_normalized_v2`, keyed by season, round, track, driver, session, and lap.
- Session: only FastF1 race session `R` rows are eligible.
- Lap eligibility: non-null time, valid, non-pit, non-in-lap, and non-out-lap.
- Clean air: when requested, the ingestion flag requires a 2.0-second gap to the car ahead; leaders are clean air.
- Sample rule: an event contributes only when a driver has at least two eligible laps. Per-event medians are then averaged across events.
- Version boundary: F1QL accepts only the active version above and returns it in pace results. Legacy/unversioned or different-methodology rows produce no pace result rather than being compared across seasons.

Apply `20260721_pace_correctness_v2.sql` before running any updated lap ETL. It creates a new table and leaves `laps_normalized` unchanged. Historical migration into v2 is an explicit review task: copy only a season after verifying its session labels, source completeness, and clean-air method all match this document.

## Schema Snapshot Contract

The committed production-schema contract is refreshed only with `npm run schema:snapshot:production` from the Railway production environment. The guarded generator requires its explicit opt-in, opens `BEGIN READ ONLY`, sets a transaction-local 10-second statement timeout, reads only `information_schema`, and rolls back. The approved v2 migration is represented by the `laps_normalized_v2` table, its 18 columns, and its six-column session-inclusive primary key; snapshot capture never backfills or alters production data.

## Production Coverage And Freshness Protocol

Run this only from an authorized production environment, inside `BEGIN READ ONLY` with a transaction-local five-second statement timeout. It performs no writes:

```sql
SELECT season, methodology_version, max(updated_at) AS newest_row,
       count(DISTINCT round) FILTER (WHERE session_type = 'R') AS race_rounds,
       count(*) FILTER (WHERE session_type = 'R') AS race_laps
FROM laps_normalized_v2
GROUP BY season, methodology_version
ORDER BY season, methodology_version;
```

Accept a season for F1QL pace only when it has exactly `clean_air_gap_2_0s_v1`, expected completed race rounds, and a plausible newest-row timestamp after the last intended ingestion. A missing v2 relation, a second methodology version, stale timestamp, or incomplete round count is a failed coverage/freshness check. Save the one read-only JSON/CSV artifact outside the database with UTC time, deployed commit, operator, and expected completed-round count. Do not backfill, alter, or repair production during this check.
