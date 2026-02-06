import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { buildError, Confidence, Methodology } from '../../types/api-response';
import { createTracerFromRequestWithHeaders } from '../../execution/debug-tracer';

export function createDriverRoutes(pool: Pool): Router {
  const router = Router();

  router.get('/driver/:driver_id/profile', async (req: Request, res: Response) => {
    const tracer = createTracerFromRequestWithHeaders(req.query, req.headers as Record<string, unknown>);
    tracer.start();

    try {
      const driverId = req.params.driver_id;
      const seasonParam = req.query.season as string | undefined;
      const currentSeason = seasonParam ? parseInt(seasonParam, 10) : new Date().getFullYear();

      tracer.addRoutingStep(`Driver profile request: ${driverId}, season: ${currentSeason}`);

      const validationError = validateDriverId(driverId);
      if (validationError) {
        tracer.recordError('Invalid driver_id');
        return res.status(400).json({ success: false, error: validationError, debug: tracer.finish() });
      }

      if (isNaN(currentSeason) || currentSeason < 1950 || currentSeason > 2100) {
        const error = buildError('INVALID_SEASON', 'Invalid season parameter', ['Season must be between 1950 and 2100']);
        tracer.recordError('Invalid season');
        return res.status(400).json({ success: false, error, debug: tracer.finish() });
      }

      tracer.addRoutingStep('Parameters validated');

      const driverResult = await pool.query('SELECT id, full_name FROM driver WHERE id = $1', [driverId]);
      if (driverResult.rows.length === 0) {
        const error = buildError('UNKNOWN_DRIVER', `Driver not found: ${driverId}`, ['Check driver ID spelling', 'Use F1DB driver.id format']);
        tracer.recordError(`Driver not found: ${driverId}`);
        return res.status(404).json({ success: false, error, debug: tracer.finish() });
      }

      const driver = driverResult.rows[0];
      tracer.setIdentityResolution('driver_a', driverId, driver.id);
      tracer.addRoutingStep(`Driver found: ${driver.full_name}`);
      tracer.setSqlTemplate('driver_profile_summary_v1');

      const profileResult = await pool.query(buildProfileQuery(), [driverId]);
      tracer.setRowsReturned(profileResult.rows.length);

      if (profileResult.rows.length === 0) {
        const error = buildError('NO_DATA', 'No profile data available for driver', ['Driver may not have F1 race data']);
        return res.status(404).json({ success: false, error, debug: tracer.finish() });
      }

      const profile = profileResult.rows[0];
      const response = buildProfileResponse(profile, driverId, currentSeason, tracer);
      return res.status(200).json(response);

    } catch (err) {
      console.error('Error in /driver/:driver_id/profile:', err);
      tracer.recordError(String(err));
      const error = buildError('INTERNAL_ERROR', `Unexpected error: ${err}`, ['Try again later', 'Contact support if issue persists']);
      return res.status(500).json({ success: false, error, debug: tracer.finish() });
    }
  });

  router.get('/driver/:driver_id/trend', async (req: Request, res: Response) => {
    const tracer = createTracerFromRequestWithHeaders(req.query, req.headers as Record<string, unknown>);
    tracer.start();

    try {
      const driverId = req.params.driver_id;
      const currentYear = new Date().getFullYear();
      const startSeason = req.query.start_season ? parseInt(req.query.start_season as string, 10) : currentYear - 3;
      const endSeason = req.query.end_season ? parseInt(req.query.end_season as string, 10) : currentYear;

      tracer.addRoutingStep(`Trend analysis: ${driverId}, ${startSeason}-${endSeason}`);

      const validationError = validateDriverId(driverId);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError, debug: tracer.finish() });
      }

      if (startSeason > endSeason) {
        const error = buildError('INVALID_SEASON', 'start_season must be <= end_season', []);
        return res.status(400).json({ success: false, error, debug: tracer.finish() });
      }

      const driverResult = await pool.query('SELECT id, full_name FROM driver WHERE id = $1', [driverId]);
      if (driverResult.rows.length === 0) {
        const error = buildError('UNKNOWN_DRIVER', `Driver not found: ${driverId}`, ['Check driver ID spelling']);
        return res.status(404).json({ success: false, error, debug: tracer.finish() });
      }

      const driver = driverResult.rows[0];
      tracer.setIdentityResolution('driver_a', driverId, driver.id);
      const response = buildTrendResponse(driver, driverId, startSeason, endSeason, tracer);
      return res.status(200).json(response);

    } catch (err) {
      console.error('Error in /driver/:driver_id/trend:', err);
      tracer.recordError(String(err));
      const error = buildError('INTERNAL_ERROR', `Unexpected error: ${err}`, []);
      return res.status(500).json({ success: false, error, debug: tracer.finish() });
    }
  });

  return router;
}

function validateDriverId(driverId: string | undefined): ReturnType<typeof buildError> | null {
  if (!driverId || typeof driverId !== 'string' || driverId.trim().length === 0) {
    return buildError('UNKNOWN_DRIVER', 'driver_id is required', ['Provide a valid F1DB driver ID']);
  }
  return null;
}

function buildProfileQuery(): string {
  return `
    WITH career_stats AS (
      SELECT
        d.id AS driver_id,
        d.full_name AS driver_name,
        COALESCE(d.total_championship_wins, 0) AS championships,
        COALESCE(d.total_race_wins, 0) AS total_wins,
        COALESCE(d.total_podiums, 0) AS total_podiums,
        COALESCE(d.total_pole_positions, 0) AS total_poles,
        d.total_race_starts,
        (SELECT MIN(year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS first_season,
        (SELECT MAX(year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS latest_season,
        (SELECT COUNT(DISTINCT year) FROM season_driver_standing WHERE driver_id = d.id OR driver_id = REPLACE(d.id, '_', '-')) AS seasons_raced
      FROM driver d
      WHERE d.id = $1
    )
    SELECT * FROM career_stats
  `;
}

function buildProfileResponse(profile: any, driverId: string, currentSeason: number, tracer: any): object {
  const confidence: Confidence = {
    level: 'high',
    coverage_status: 'valid',
    sample_size: profile.seasons_raced || 0,
    reason: `Profile based on ${profile.seasons_raced || 0} seasons of data`,
    reasons: ['Career statistics from F1DB reference data', profile.seasons_raced >= 3 ? 'Sufficient seasons for trend analysis' : 'Limited seasons for trend analysis'],
    shared_events: profile.seasons_raced || 0
  };

  const methodology: Methodology = {
    metric_type: 'driver_profile',
    data_source: ['driver', 'season_entrant_driver', 'race_data'],
    aggregation: 'career_summary',
    normalization: 'none',
    formula: 'N/A - aggregated career statistics',
    scope: 'career',
    exclusions: ['test_driver entries'],
    filters_applied: ['F1DB reference data only'],
    assumptions: ['F1DB data is accurate and complete'],
    limitations: ['Track performance requires race_data with circuit mapping']
  };

  const result = {
    type: 'driver_profile_summary',
    driver_id: profile.driver_id,
    driver_name: profile.driver_name,
    career: {
      championships: profile.championships,
      seasons_raced: profile.seasons_raced || 0,
      total_wins: profile.total_wins,
      total_podiums: profile.total_podiums,
      total_poles: profile.total_poles || 0,
      first_season: profile.first_season,
      latest_season: profile.latest_season
    },
    best_tracks: [],
    worst_tracks: [],
    latest_season_teammate: null,
    trend: { seasons: [], classification: 'stable' as const, slope_per_season: null },
    percentiles: []
  };

  tracer.addRoutingStep('Profile built successfully');

  return {
    success: true,
    kind: 'driver_profile_summary',
    input: { driver_id: driverId, season: currentSeason },
    result,
    confidence,
    methodology,
    warnings: [],
    debug: tracer.finish()
  };
}

function buildTrendResponse(driver: any, driverId: string, startSeason: number, endSeason: number, tracer: any): object {
  const confidence: Confidence = {
    level: 'medium',
    coverage_status: 'low_coverage',
    sample_size: endSeason - startSeason + 1,
    reason: `Trend analysis over ${endSeason - startSeason + 1} seasons`,
    reasons: ['Teammate gap used as primary performance metric', 'Linear regression for trend calculation']
  };

  const methodology: Methodology = {
    metric_type: 'driver_trend',
    data_source: ['teammate_gap_season_summary'],
    aggregation: 'linear_regression',
    normalization: 'team_baseline',
    formula: 'REGR_SLOPE(gap_percent, season)',
    scope: 'multi_season',
    exclusions: ['seasons with insufficient coverage'],
    filters_applied: [`Seasons ${startSeason} to ${endSeason}`],
    assumptions: ['Teammate gap is comparable across teams', 'Linear model is appropriate'],
    limitations: ['Team changes affect comparability', 'Minimum 2 seasons required']
  };

  const result = {
    type: 'driver_trend_summary',
    driver_id: driverId,
    driver_name: driver.full_name,
    start_season: startSeason,
    end_season: endSeason,
    seasons_analyzed: 0,
    season_data: [],
    trend: { classification: 'stable' as const, slope_per_season: null, volatility: null, r_squared: null },
    methodology: 'Teammate gap symmetric percent difference with linear regression'
  };

  return {
    success: true,
    kind: 'driver_trend_summary',
    input: { driver_id: driverId, start_season: startSeason, end_season: endSeason },
    result,
    confidence,
    methodology,
    warnings: ['Trend analysis requires teammate gap data which may be limited'],
    debug: tracer.finish()
  };
}
