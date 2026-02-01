import { Pool } from 'pg';

const DEFAULT_SEASON = 2025;

function parseSeasonArg(): number {
  const raw = process.argv[2];
  if (!raw) {
    return DEFAULT_SEASON;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid season: ${raw}`);
  }
  return parsed;
}

async function run(): Promise<void> {
  const season = parseSeasonArg();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log(`=== PACE METRICS POPULATION (${season}) ===`);

    const lapsCountResult = await client.query(
      `SELECT COUNT(*)::int AS total FROM laps_normalized WHERE season = $1`,
      [season]
    );
    const totalLaps = lapsCountResult.rows[0]?.total ?? 0;
    if (totalLaps === 0) {
      throw new Error(`No laps_normalized rows found for season ${season}`);
    }

    console.log(`OK Found ${totalLaps} laps for season ${season}`);

    await client.query('BEGIN');

    await client.query(
      `
      DELETE FROM pace_metric_summary_driver_track
      WHERE season = $1
        AND metric_name = 'avg_true_pace'
        AND normalization = 'none'
        AND clean_air_only = false
        AND compound_context = 'mixed'
        AND session_scope = 'race'
      `,
      [season]
    );

    const trackMetricsResult = await client.query(
      `
      INSERT INTO pace_metric_summary_driver_track
      (season, track_id, driver_id, metric_name, metric_value, normalization,
       laps_considered, clean_air_only, compound_context, session_scope)
      SELECT
        season,
        track_id,
        driver_id,
        'avg_true_pace' AS metric_name,
        AVG(lap_time_seconds)::numeric AS metric_value,
        'none' AS normalization,
        COUNT(*)::int AS laps_considered,
        false AS clean_air_only,
        'mixed' AS compound_context,
        'race' AS session_scope
      FROM laps_normalized
      WHERE season = $1
        AND is_valid_lap = true
        AND lap_time_seconds IS NOT NULL
      GROUP BY season, track_id, driver_id
      `,
      [season]
    );

    await client.query('COMMIT');

    console.log(`OK Track metrics upserted: ${trackMetricsResult.rowCount}`);

    await client.query('BEGIN');

    await client.query(
      `
      DELETE FROM pace_metric_summary_driver_season
      WHERE season = $1
        AND metric_name = 'driver_above_baseline'
        AND normalization IN ('car_baseline_adjusted', 'team_baseline')
        AND clean_air_only = false
        AND compound_context = 'mixed'
        AND session_scope = 'all'
      `,
      [season]
    );

    const seasonBaselineResult = await client.query(
      `
      WITH driver_track AS (
        SELECT
          season,
          track_id,
          driver_id,
          metric_value,
          laps_considered
        FROM pace_metric_summary_driver_track
        WHERE season = $1
          AND metric_name = 'avg_true_pace'
          AND normalization = 'none'
          AND clean_air_only = false
          AND compound_context = 'mixed'
          AND session_scope = 'race'
      ),
      track_baseline AS (
        SELECT
          season,
          track_id,
          AVG(metric_value) AS track_avg
        FROM driver_track
        GROUP BY season, track_id
      ),
      driver_deltas AS (
        SELECT
          dt.season,
          dt.driver_id,
          dt.laps_considered,
          (dt.metric_value - tb.track_avg) AS delta
        FROM driver_track dt
        JOIN track_baseline tb
          ON tb.season = dt.season
         AND tb.track_id = dt.track_id
      )
      INSERT INTO pace_metric_summary_driver_season
      (season, driver_id, metric_name, metric_value, normalization,
       laps_considered, clean_air_only, compound_context, session_scope)
      SELECT
        season,
        driver_id,
        'driver_above_baseline' AS metric_name,
        SUM(delta * laps_considered) / NULLIF(SUM(laps_considered), 0) AS metric_value,
        'car_baseline_adjusted' AS normalization,
        SUM(laps_considered)::int AS laps_considered,
        false AS clean_air_only,
        'mixed' AS compound_context,
        'all' AS session_scope
      FROM driver_deltas
      GROUP BY season, driver_id
      `,
      [season]
    );

    const teamBaselineResult = await client.query(
      `
      WITH driver_track AS (
        SELECT
          season,
          track_id,
          driver_id,
          metric_value,
          laps_considered
        FROM pace_metric_summary_driver_track
        WHERE season = $1
          AND metric_name = 'avg_true_pace'
          AND normalization = 'none'
          AND clean_air_only = false
          AND compound_context = 'mixed'
          AND session_scope = 'race'
      ),
      driver_team AS (
        SELECT year AS season, driver_id, constructor_id AS team_id
        FROM season_entrant_driver
        WHERE year = $1
          AND test_driver IS NOT TRUE
      ),
      driver_track_team AS (
        SELECT
          dt.season,
          dt.track_id,
          dt.driver_id,
          dt.metric_value,
          dt.laps_considered,
          dt.team_id
        FROM (
          SELECT
            dt.*,
            t.team_id
          FROM driver_track dt
          JOIN driver_team t
            ON t.season = dt.season
           AND t.driver_id = dt.driver_id
        ) AS dt
      ),
      team_track_baseline AS (
        SELECT
          season,
          track_id,
          team_id,
          AVG(metric_value) AS team_track_avg
        FROM driver_track_team
        GROUP BY season, track_id, team_id
      ),
      driver_team_deltas AS (
        SELECT
          dtt.season,
          dtt.driver_id,
          dtt.laps_considered,
          (dtt.metric_value - ttb.team_track_avg) AS delta
        FROM driver_track_team dtt
        JOIN team_track_baseline ttb
          ON ttb.season = dtt.season
         AND ttb.track_id = dtt.track_id
         AND ttb.team_id = dtt.team_id
      )
      INSERT INTO pace_metric_summary_driver_season
      (season, driver_id, metric_name, metric_value, normalization,
       laps_considered, clean_air_only, compound_context, session_scope)
      SELECT
        season,
        driver_id,
        'driver_above_baseline' AS metric_name,
        SUM(delta * laps_considered) / NULLIF(SUM(laps_considered), 0) AS metric_value,
        'team_baseline' AS normalization,
        SUM(laps_considered)::int AS laps_considered,
        false AS clean_air_only,
        'mixed' AS compound_context,
        'all' AS session_scope
      FROM driver_team_deltas
      GROUP BY season, driver_id
      `,
      [season]
    );

    await client.query('COMMIT');

    console.log(`OK Season metrics (car baseline) upserted: ${seasonBaselineResult.rowCount}`);
    console.log(`OK Season metrics (team baseline) upserted: ${teamBaselineResult.rowCount}`);

    console.log('=== METRICS COMPLETE ===');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error(`FAIL_CLOSED: ${error.message}`);
  process.exitCode = 1;
});
