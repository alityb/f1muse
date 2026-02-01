import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../src/execution/query-executor';
import { setupTestDatabase, cleanupTestDatabase, getTestDatabaseUrl } from '../src/test/setup';
import { TeammateGapDualComparisonPayload } from '../src/types/results';
import { QueryIntent } from '../src/types/query-intent';

let pool: Pool;
let executor: QueryExecutor;
let dbAvailable = false;

const SEASON = 2025;

type CoverageStatus = 'valid' | 'low_coverage' | 'insufficient';

async function createQualifyingSummaryTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teammate_gap_qualifying_season_summary_2025 (
      season INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      driver_primary_id TEXT NOT NULL,
      driver_secondary_id TEXT NOT NULL,
      driver_pair_gap_percent NUMERIC(8,3),
      driver_pair_gap_seconds NUMERIC(8,6),
      gap_percent NUMERIC(8,3),
      shared_races INTEGER NOT NULL,
      faster_driver_primary_count INTEGER NOT NULL,
      coverage_status TEXT NOT NULL,
      failure_reason TEXT
    )
  `);
}

async function truncateSummaries(): Promise<void> {
  await pool.query('TRUNCATE teammate_gap_qualifying_season_summary_2025');
  await pool.query('TRUNCATE teammate_gap_season_summary_2025');
}

async function insertQualifyingRow(input: {
  team_id: string;
  driver_primary_id: string;
  driver_secondary_id: string;
  gap_percent: number | null;
  gap_seconds: number | null;
  shared_races: number;
  faster_primary_count: number;
  coverage_status: CoverageStatus;
}): Promise<void> {
  await pool.query(
    `
    INSERT INTO teammate_gap_qualifying_season_summary_2025 (
      season,
      team_id,
      driver_primary_id,
      driver_secondary_id,
      driver_pair_gap_percent,
      driver_pair_gap_seconds,
      gap_percent,
      shared_races,
      faster_driver_primary_count,
      coverage_status,
      failure_reason
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
    `,
    [
      SEASON,
      input.team_id,
      input.driver_primary_id,
      input.driver_secondary_id,
      input.gap_percent,
      input.gap_seconds,
      input.gap_percent,
      input.shared_races,
      input.faster_primary_count,
      input.coverage_status
    ]
  );
}

async function insertRaceRow(input: {
  team_id: string;
  driver_primary_id: string;
  driver_secondary_id: string;
  gap_percent: number | null;
  gap_seconds: number | null;
  shared_races: number;
  faster_primary_count: number;
  coverage_status: CoverageStatus;
}): Promise<void> {
  await pool.query(
    `
    INSERT INTO teammate_gap_season_summary_2025 (
      season,
      team_id,
      driver_primary_id,
      driver_secondary_id,
      driver_pair_gap_percent,
      driver_pair_gap_seconds,
      gap_percent,
      shared_races,
      faster_driver_primary_count,
      coverage_status,
      failure_reason
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
    `,
    [
      SEASON,
      input.team_id,
      input.driver_primary_id,
      input.driver_secondary_id,
      input.gap_percent,
      input.gap_seconds,
      input.gap_percent,
      input.shared_races,
      input.faster_primary_count,
      input.coverage_status
    ]
  );
}

function buildIntent(driverA: string, driverB: string): QueryIntent {
  return {
    kind: 'teammate_gap_dual_comparison',
    driver_a_id: driverA,
    driver_b_id: driverB,
    season: SEASON,
    metric: 'avg_true_pace',
    normalization: 'none',
    clean_air_only: false,
    compound_context: 'combined',
    session_scope: 'race',
    raw_query: `Compare qualifying vs race pace for ${driverA} and ${driverB} ${SEASON}`
  } as QueryIntent;
}

async function runDualComparison(
  driverA: string,
  driverB: string
): Promise<{ response: any; payload: TeammateGapDualComparisonPayload | null }> {
  const response = await executor.executeDualComparisonResponse(
    buildIntent(driverA, driverB) as Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>
  );
  const payload = response.result as TeammateGapDualComparisonPayload | null;
  return { response, payload };
}

beforeAll(async () => {
  try {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await pool.query('SELECT 1');
    await setupTestDatabase(pool);
    await createQualifyingSummaryTable();
    executor = new QueryExecutor(pool);
    dbAvailable = true;
  } catch {
    console.log('Test database not available, skipping dual comparison tests');
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (!dbAvailable) { return; }
  await truncateSummaries();
});

afterAll(async () => {
  if (!dbAvailable) { return; }
  await cleanupTestDatabase(pool);
  await pool.end();
});

describe('Teammate gap dual comparison', () => {
  it.skipIf(!dbAvailable)('returns both metrics when available', async () => {
    await insertQualifyingRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: -0.2,
      gap_seconds: -0.15,
      shared_races: 8,
      faster_primary_count: 6,
      coverage_status: 'valid'
    });

    await insertRaceRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: 0.3,
      gap_seconds: 0.25,
      shared_races: 8,
      faster_primary_count: 3,
      coverage_status: 'valid'
    });

    const { response, payload } = await runDualComparison('lando_norris', 'oscar_piastri');

    expect(response.error).toBeUndefined();
    expect(payload?.qualifying.available).toBe(true);
    expect(payload?.race_pace.available).toBe(true);
    expect(payload?.qualifying.winner).toBe('lando_norris');
    expect(payload?.race_pace.winner).toBe('oscar_piastri');
    expect(payload?.overall_summary.advantage_area).toBe('race');
    expect(response.confidence.level).toBe('high');
  });

  it.skipIf(!dbAvailable)('handles qualifying-only availability', async () => {
    await insertQualifyingRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: -0.12,
      gap_seconds: -0.1,
      shared_races: 4,
      faster_primary_count: 3,
      coverage_status: 'low_coverage'
    });

    const { response, payload } = await runDualComparison('lando_norris', 'oscar_piastri');

    expect(payload?.qualifying.available).toBe(true);
    expect(payload?.race_pace.available).toBe(false);
    expect(response.warnings.some((warning: string) => warning.includes('Partial result'))).toBe(true);
    expect(response.confidence.level).toBe('medium');
  });

  it.skipIf(!dbAvailable)('handles race-only availability', async () => {
    await insertRaceRow({
      team_id: 'red-bull',
      driver_primary_id: 'max_verstappen',
      driver_secondary_id: 'sergio_perez',
      gap_percent: -0.08,
      gap_seconds: -0.07,
      shared_races: 4,
      faster_primary_count: 3,
      coverage_status: 'low_coverage'
    });

    const { response, payload } = await runDualComparison('max_verstappen', 'sergio_perez');

    expect(payload?.qualifying.available).toBe(false);
    expect(payload?.race_pace.available).toBe(true);
    expect(payload?.overall_summary.advantage_area).toBe('partial');
    expect(payload?.overall_summary.same_winner).toBeNull();
    expect(response.warnings.some((warning: string) => warning.includes('Partial result'))).toBe(true);
  });

  it.skipIf(!dbAvailable)('returns NO_DATA when both metrics are missing', async () => {
    const { response } = await runDualComparison('charles_leclerc', 'carlos_sainz');

    expect(response.result).toBeNull();
    expect(response.error?.code).toBe('NO_DATA');
  });

  it.skipIf(!dbAvailable)('returns NOT_TEAMMATES when drivers are not teammates', async () => {
    const { response } = await runDualComparison('lando_norris', 'max_verstappen');

    expect(response.result).toBeNull();
    expect(response.error?.code).toBe('NOT_TEAMMATES');
  });

  it.skipIf(!dbAvailable)('handles equal performance edge case', async () => {
    await insertQualifyingRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: 0.0,
      gap_seconds: 0.0,
      shared_races: 8,
      faster_primary_count: 4,
      coverage_status: 'valid'
    });

    await insertRaceRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: 0.0,
      gap_seconds: 0.0,
      shared_races: 8,
      faster_primary_count: 4,
      coverage_status: 'valid'
    });

    const { payload } = await runDualComparison('lando_norris', 'oscar_piastri');

    expect(payload?.qualifying.winner).toBe('equal');
    expect(payload?.race_pace.winner).toBe('equal');
    expect(payload?.overall_summary.same_winner).toBe(true);
    expect(payload?.overall_summary.advantage_area).toBe('mixed');
  });

  it.skipIf(!dbAvailable)('respects coverage threshold boundaries', async () => {
    await insertQualifyingRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: -0.05,
      gap_seconds: -0.04,
      shared_races: 4,
      faster_primary_count: 2,
      coverage_status: 'low_coverage'
    });

    await insertRaceRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: 0.06,
      gap_seconds: 0.05,
      shared_races: 4,
      faster_primary_count: 2,
      coverage_status: 'low_coverage'
    });

    let response = (await runDualComparison('lando_norris', 'oscar_piastri')).response;
    expect(response.confidence.level).toBe('medium');

    await truncateSummaries();

    await insertQualifyingRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: -0.07,
      gap_seconds: -0.06,
      shared_races: 8,
      faster_primary_count: 5,
      coverage_status: 'valid'
    });

    await insertRaceRow({
      team_id: 'mclaren',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      gap_percent: 0.09,
      gap_seconds: 0.08,
      shared_races: 8,
      faster_primary_count: 4,
      coverage_status: 'valid'
    });

    response = (await runDualComparison('lando_norris', 'oscar_piastri')).response;
    expect(response.confidence.level).toBe('high');
  });
});
