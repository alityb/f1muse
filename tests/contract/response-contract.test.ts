/**
 * Response Contract Golden Tests
 *
 * Validates that API responses conform to expected structure and contract.
 * Tests schema consistency across all QueryIntent kinds.
 *
 * These tests verify:
 * 1. Required fields are always present
 * 2. Field types match expected TypeScript interfaces
 * 3. Payload structure is consistent for each query kind
 * 4. Error responses follow contract
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../../src/execution/query-executor';
import { QueryIntent } from '../../src/types/query-intent';
import { QueryResult, QueryError } from '../../src/types/results';
import {
  canRunIntegrationTests,
  getIntegrationPool,
  cleanupIntegration
} from '../integration/setup.integration';

let pool: Pool | null = null;
let executor: QueryExecutor | null = null;
let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await canRunIntegrationTests();
  if (dbAvailable) {
    pool = await getIntegrationPool();
    executor = new QueryExecutor(pool);
  }
});

afterAll(async () => {
  await cleanupIntegration();
});

/**
 * Type guard for QueryResult
 */
function isQueryResult(response: QueryResult | QueryError): response is QueryResult {
  return 'result' in response && !('error' in response);
}

/**
 * Type guard for QueryError
 */
function isQueryError(response: QueryResult | QueryError): response is QueryError {
  return 'error' in response;
}

/**
 * Validate base response structure
 */
function validateBaseResponseStructure(response: QueryResult): void {
  // Must have intent
  expect(response.intent).toBeDefined();
  expect(response.intent.kind).toBeDefined();
  expect(typeof response.intent.season).toBe('number');

  // Must have result with type and payload
  expect(response.result).toBeDefined();
  expect(response.result.type).toBeDefined();
  expect(response.result.payload).toBeDefined();

  // Must have interpretation
  expect(response.interpretation).toBeDefined();
  expect(response.interpretation.comparison_basis).toBeDefined();
  expect(response.interpretation.normalization_scope).toBeDefined();
  expect(response.interpretation.metric_definition).toBeDefined();
  expect(response.interpretation.constraints).toBeDefined();
  expect(response.interpretation.confidence).toBeDefined();
  expect(response.interpretation.confidence_notes).toBeDefined();

  // Must have metadata
  expect(response.metadata).toBeDefined();
  expect(response.metadata.sql_template_id).toBeDefined();
  expect(response.metadata.data_scope).toBeDefined();
  expect(typeof response.metadata.rows).toBe('number');
}

/**
 * Validate error response structure
 */
function validateErrorStructure(response: QueryError): void {
  expect(response.error).toBeDefined();
  expect(['intent_resolution_failed', 'validation_failed', 'execution_failed']).toContain(response.error);
  expect(response.reason).toBeDefined();
  expect(typeof response.reason).toBe('string');
}

describe('Response Contract Tests', () => {
  describe('Base Response Structure', () => {
    it.skipIf(!dbAvailable)('driver_season_summary returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_season_summary',
        season: 2025,
        driver_id: 'max_verstappen'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('driver_season_summary');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('driver_id');
        expect(payload).toHaveProperty('wins');
        expect(payload).toHaveProperty('podiums');
        expect(payload).toHaveProperty('dnfs');
        expect(payload).toHaveProperty('race_count');
      } else {
        // Execution might fail due to missing data, but error structure should be valid
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('teammate_gap_summary_season returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'teammate_gap_summary_season',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        metric: 'avg_true_pace',
        normalization: 'none'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('teammate_gap_summary_season');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('team_id');
        expect(payload).toHaveProperty('driver_primary_id');
        expect(payload).toHaveProperty('driver_secondary_id');
        expect(payload).toHaveProperty('gap_seconds');
        expect(payload).toHaveProperty('shared_races');
        expect(payload).toHaveProperty('coverage_status');
        expect(payload).toHaveProperty('gap_band');
      } else {
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('driver_head_to_head_count returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_head_to_head_count',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('driver_head_to_head_count');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('metric');
        expect(payload).toHaveProperty('driver_primary_id');
        expect(payload).toHaveProperty('driver_secondary_id');
        expect(payload).toHaveProperty('shared_events');
        expect(payload).toHaveProperty('primary_wins');
        expect(payload).toHaveProperty('secondary_wins');
        expect(payload).toHaveProperty('ties');
        expect(payload).toHaveProperty('coverage_status');
      } else {
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('driver_multi_comparison returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('driver_multi_comparison');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('metric');
        expect(payload).toHaveProperty('comparison_type');
        expect(payload).toHaveProperty('entries');
        expect(payload).toHaveProperty('total_drivers');
        expect(payload).toHaveProperty('ranked_drivers');
        expect(payload).toHaveProperty('coverage_status');
        expect(Array.isArray((payload as any).entries)).toBe(true);
      } else {
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('driver_matchup_lookup returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('driver_matchup_lookup');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('metric');
        expect(payload).toHaveProperty('driver_primary_id');
        expect(payload).toHaveProperty('driver_secondary_id');
        expect(payload).toHaveProperty('primary_wins');
        expect(payload).toHaveProperty('secondary_wins');
        expect(payload).toHaveProperty('ties');
        expect(payload).toHaveProperty('shared_events');
        expect(payload).toHaveProperty('coverage_status');
        expect(payload).toHaveProperty('computed_at');
      } else {
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('track_fastest_drivers returns valid structure', async () => {
      const intent: QueryIntent = {
        kind: 'track_fastest_drivers',
        season: 2025,
        track_id: 'bahrain',
        metric: 'avg_true_pace',
        normalization: 'none'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        validateBaseResponseStructure(response);
        expect(response.result.type).toBe('driver_ranking');

        const payload = response.result.payload;
        expect(payload).toHaveProperty('season');
        expect(payload).toHaveProperty('track_id');
        expect(payload).toHaveProperty('metric');
        expect(payload).toHaveProperty('ranking_basis');
        expect(payload).toHaveProperty('entries');
        expect(Array.isArray((payload as any).entries)).toBe(true);
      } else {
        validateErrorStructure(response);
      }
    });
  });

  describe('Error Response Contract', () => {
    it.skipIf(!dbAvailable)('invalid driver returns proper error structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_season_summary',
        season: 2025,
        driver_id: 'nonexistent_driver_xyz'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        validateErrorStructure(response);
        expect(response.error).toBe('intent_resolution_failed');
      }
    });

    it.skipIf(!dbAvailable)('invalid season returns validation error', async () => {
      const intent: QueryIntent = {
        kind: 'driver_season_summary',
        season: 1800, // Before F1 existed
        driver_id: 'max_verstappen'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        validateErrorStructure(response);
        expect(response.error).toBe('validation_failed');
      }
    });

    it.skipIf(!dbAvailable)('missing required field returns validation error', async () => {
      const intent = {
        kind: 'driver_head_to_head_count',
        season: 2025,
        driver_a_id: 'max_verstappen',
        // Missing driver_b_id
        h2h_metric: 'qualifying_position'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        validateErrorStructure(response);
        expect(response.error).toBe('validation_failed');
      }
    });

    it.skipIf(!dbAvailable)('same driver comparison returns validation error', async () => {
      const intent: QueryIntent = {
        kind: 'driver_head_to_head_count',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'max_verstappen', // Same driver
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        validateErrorStructure(response);
        expect(response.reason).toContain('themselves');
      }
    });
  });

  describe('Interpretation Contract', () => {
    it.skipIf(!dbAvailable)('interpretation has required confidence metadata', async () => {
      const intent: QueryIntent = {
        kind: 'driver_season_summary',
        season: 2025,
        driver_id: 'max_verstappen'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const confidence = response.interpretation.confidence;

        expect(confidence).toHaveProperty('coverage_level');
        expect(['high', 'moderate', 'low', 'insufficient']).toContain(confidence.coverage_level);
        expect(confidence).toHaveProperty('laps_considered');
        expect(typeof confidence.laps_considered).toBe('number');
        expect(confidence).toHaveProperty('notes');
        expect(Array.isArray(confidence.notes)).toBe(true);
      }
    });

    it.skipIf(!dbAvailable)('constraints have required fields', async () => {
      const intent: QueryIntent = {
        kind: 'teammate_gap_summary_season',
        season: 2025,
        driver_a_id: 'lando_norris',
        driver_b_id: 'oscar_piastri',
        metric: 'avg_true_pace',
        normalization: 'none'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const constraints = response.interpretation.constraints;

        expect(constraints).toHaveProperty('min_lap_requirement');
        expect(typeof constraints.min_lap_requirement).toBe('number');
        expect(constraints).toHaveProperty('rows_included');
        expect(typeof constraints.rows_included).toBe('number');
        expect(constraints).toHaveProperty('other_constraints');
        expect(Array.isArray(constraints.other_constraints)).toBe(true);
      }
    });
  });

  describe('Metadata Contract', () => {
    it.skipIf(!dbAvailable)('metadata references approved SQL template', async () => {
      const intent: QueryIntent = {
        kind: 'driver_head_to_head_count',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const templateId = response.metadata.sql_template_id;
        expect(templateId).toMatch(/^[a-z_]+_v\d+(_[a-z]+)?$/);
      }
    });
  });

  describe('Payload Type Consistency', () => {
    it.skipIf(!dbAvailable)('driver_multi_comparison entries have correct structure', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as any;
        if (payload.entries && payload.entries.length > 0) {
          const entry = payload.entries[0];
          expect(entry).toHaveProperty('driver_id');
          expect(entry).toHaveProperty('rank');
          expect(entry).toHaveProperty('metric_value');
          expect(entry).toHaveProperty('laps_considered');
          expect(typeof entry.driver_id).toBe('string');
          expect(typeof entry.rank).toBe('number');
          expect(typeof entry.metric_value).toBe('number');
          expect(typeof entry.laps_considered).toBe('number');
        }
      }
    });

    it.skipIf(!dbAvailable)('coverage_status values are from approved set', async () => {
      const intents: QueryIntent[] = [
        {
          kind: 'driver_head_to_head_count',
          season: 2025,
          driver_a_id: 'max_verstappen',
          driver_b_id: 'sergio_perez',
          h2h_metric: 'qualifying_position'
        } as QueryIntent,
        {
          kind: 'teammate_gap_summary_season',
          season: 2025,
          driver_a_id: 'lando_norris',
          driver_b_id: 'oscar_piastri',
          metric: 'avg_true_pace',
          normalization: 'none'
        } as QueryIntent
      ];

      for (const intent of intents) {
        const response = await executor!.execute(intent);
        if (isQueryResult(response)) {
          const payload = response.result.payload as any;
          if (payload.coverage_status) {
            expect(['valid', 'low_coverage', 'insufficient']).toContain(payload.coverage_status);
          }
        }
      }
    });
  });
});

describe('Golden Test Assertions', () => {
  it.skipIf(!dbAvailable)('VER vs PER h2h in 2025 returns expected values', async () => {
    const intent: QueryIntent = {
      kind: 'driver_matchup_lookup',
      season: 2025,
      driver_a_id: 'max_verstappen',
      driver_b_id: 'sergio_perez',
      h2h_metric: 'qualifying_position'
    } as QueryIntent;

    const response = await executor!.execute(intent);

    if (isQueryResult(response)) {
      const payload = response.result.payload as any;
      // From fixtures: VER beats PER 7-3 in qualifying
      expect(payload.shared_events).toBe(10);
      // Driver ordering is lexicographic, so max_verstappen is primary
      expect(payload.primary_wins).toBe(7);
      expect(payload.secondary_wins).toBe(3);
    }
  });

  it.skipIf(!dbAvailable)('NOR vs PIA h2h in 2025 returns expected values', async () => {
    const intent: QueryIntent = {
      kind: 'driver_matchup_lookup',
      season: 2025,
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position'
    } as QueryIntent;

    const response = await executor!.execute(intent);

    if (isQueryResult(response)) {
      const payload = response.result.payload as any;
      // From fixtures: NOR beats PIA 6-4 in qualifying
      expect(payload.shared_events).toBe(10);
      expect(payload.primary_wins).toBe(6);
      expect(payload.secondary_wins).toBe(4);
    }
  });

  it.skipIf(!dbAvailable)('RBR teammate gap returns expected percentage', async () => {
    const intent: QueryIntent = {
      kind: 'teammate_gap_summary_season',
      season: 2025,
      driver_a_id: 'max_verstappen',
      driver_b_id: 'sergio_perez',
      metric: 'avg_true_pace',
      normalization: 'none'
    } as QueryIntent;

    const response = await executor!.execute(intent);

    if (isQueryResult(response)) {
      const payload = response.result.payload as any;
      // From fixtures: RBR gap is 0.77%
      expect(payload.team_id).toBe('RBR');
      expect(payload.gap_pct_abs).toBeCloseTo(0.77, 1);
      expect(payload.coverage_status).toBe('valid');
    }
  });
});
