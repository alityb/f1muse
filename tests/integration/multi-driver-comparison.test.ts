/**
 * Multi-Driver Comparison Integration Tests (PART D)
 *
 * Tests for the driver_multi_comparison query kind:
 * - 2-6 driver comparisons
 * - Ranking correctness
 * - Coverage status
 * - Metric validity
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../../src/execution/query-executor';
import { QueryIntent } from '../../src/types/query-intent';
import { QueryResult, QueryError, DriverMultiComparisonPayload } from '../../src/types/results';
import {
  canRunIntegrationTests,
  getIntegrationPool,
  cleanupIntegration
} from './setup.integration';
import { EXPECTED_RESULTS } from './fixtures';

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

function isQueryResult(response: QueryResult | QueryError): response is QueryResult {
  return 'result' in response && !('error' in response);
}

function isQueryError(response: QueryResult | QueryError): response is QueryError {
  return 'error' in response;
}

describe('Multi-Driver Comparison Integration Tests', () => {
  describe('Valid Comparisons', () => {
    it.skipIf(!dbAvailable)('compares 2 drivers on avg_true_pace', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.result.type).toBe('driver_multi_comparison');
        const payload = response.result.payload as DriverMultiComparisonPayload;

        expect(payload.season).toBe(2025);
        expect(payload.metric).toBe('avg_true_pace');
        expect(payload.comparison_type).toBe('head_to_head'); // 2 drivers = head_to_head
        expect(payload.total_drivers).toBe(2);
        expect(payload.entries).toHaveLength(2);

        // Verify ranking structure
        for (const entry of payload.entries) {
          expect(entry).toHaveProperty('driver_id');
          expect(entry).toHaveProperty('rank');
          expect(entry).toHaveProperty('metric_value');
          expect(entry).toHaveProperty('laps_considered');
          expect(typeof entry.rank).toBe('number');
          expect(entry.rank).toBeGreaterThanOrEqual(1);
        }
      } else {
        // If no data, should be proper error
        validateErrorStructure(response);
      }
    });

    it.skipIf(!dbAvailable)('compares 3 drivers on avg_true_pace', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        expect(payload.comparison_type).toBe('multi_driver'); // 3+ drivers = multi_driver
        expect(payload.total_drivers).toBe(3);
        expect(payload.entries.length).toBeGreaterThanOrEqual(0);
        expect(payload.entries.length).toBeLessThanOrEqual(3);

        // Ranks should be sequential starting from 1
        const ranks = payload.entries.map(e => e.rank);
        for (let i = 0; i < ranks.length; i++) {
          expect(ranks[i]).toBe(i + 1);
        }
      }
    });

    it.skipIf(!dbAvailable)('compares 6 drivers (maximum allowed)', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: [
          'max_verstappen',
          'sergio_perez',
          'charles_leclerc',
          'carlos_sainz',
          'lando_norris',
          'oscar_piastri'
        ],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        expect(payload.comparison_type).toBe('multi_driver');
        expect(payload.total_drivers).toBe(6);
        // Some drivers may not have data, so ranked_drivers <= total_drivers
        expect(payload.ranked_drivers).toBeLessThanOrEqual(6);
      }
    });

    it.skipIf(!dbAvailable)('compares drivers on qualifying_pace metric', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'qualifying_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;
        expect(payload.metric).toBe('qualifying_pace');
      }
    });

    it.skipIf(!dbAvailable)('compares drivers on consistency metric', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'consistency'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;
        expect(payload.metric).toBe('consistency');
      }
    });
  });

  describe('Ranking Correctness', () => {
    it.skipIf(!dbAvailable)('ranks drivers by lower metric value (lower is faster)', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        if (payload.entries.length >= 2) {
          // Verify metric values are in ascending order (lower = faster)
          for (let i = 1; i < payload.entries.length; i++) {
            expect(payload.entries[i].metric_value).toBeGreaterThanOrEqual(
              payload.entries[i - 1].metric_value
            );
          }
        }
      }
    });

    it.skipIf(!dbAvailable)('assigns sequential ranks starting from 1', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'sergio_perez', 'lando_norris', 'oscar_piastri'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        const ranks = payload.entries.map(e => e.rank);
        const expectedRanks = Array.from({ length: ranks.length }, (_, i) => i + 1);

        expect(ranks).toEqual(expectedRanks);
      }
    });

    it.skipIf(!dbAvailable)('includes laps_considered for each entry', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        for (const entry of payload.entries) {
          expect(typeof entry.laps_considered).toBe('number');
          expect(entry.laps_considered).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('Coverage Status', () => {
    it.skipIf(!dbAvailable)('returns coverage_status in response', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;
        expect(['valid', 'low_coverage', 'insufficient']).toContain(payload.coverage_status);
      }
    });

    it.skipIf(!dbAvailable)('handles drivers with no data gracefully', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'nonexistent_driver'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      // Should either fail identity resolution or return partial data
      if (isQueryError(response)) {
        expect(response.error).toBe('intent_resolution_failed');
      }
    });

    it.skipIf(!dbAvailable)('distinguishes ranked_drivers from total_drivers', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'charles_leclerc'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMultiComparisonPayload;

        expect(payload.total_drivers).toBe(3);
        expect(payload.ranked_drivers).toBeLessThanOrEqual(payload.total_drivers);
        expect(payload.entries.length).toBe(payload.ranked_drivers);
      }
    });
  });

  describe('Validation', () => {
    it.skipIf(!dbAvailable)('rejects less than 2 drivers', async () => {
      const intent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen'],
        comparison_metric: 'avg_true_pace'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('at least 2');
      }
    });

    it.skipIf(!dbAvailable)('rejects more than 6 drivers', async () => {
      const intent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: [
          'max_verstappen',
          'sergio_perez',
          'charles_leclerc',
          'carlos_sainz',
          'lando_norris',
          'oscar_piastri',
          'lewis_hamilton' // 7th driver - too many
        ],
        comparison_metric: 'avg_true_pace'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('6');
      }
    });

    it.skipIf(!dbAvailable)('rejects duplicate drivers', async () => {
      const intent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris', 'max_verstappen'],
        comparison_metric: 'avg_true_pace'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('duplicate');
      }
    });

    it.skipIf(!dbAvailable)('rejects invalid comparison_metric', async () => {
      const intent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'invalid_metric'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('comparison_metric');
      }
    });

    it.skipIf(!dbAvailable)('rejects missing comparison_metric', async () => {
      const intent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris']
        // Missing comparison_metric
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
      }
    });
  });

  describe('Interpretation and Metadata', () => {
    it.skipIf(!dbAvailable)('includes comparison_basis in interpretation', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.interpretation.comparison_basis).toBeDefined();
        expect(response.interpretation.comparison_basis.length).toBeGreaterThan(0);
      }
    });

    it.skipIf(!dbAvailable)('includes metric definition', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.interpretation.metric_definition).toBeDefined();
        expect(response.interpretation.metric_definition.length).toBeGreaterThan(0);
      }
    });

    it.skipIf(!dbAvailable)('uses correct SQL template', async () => {
      const intent: QueryIntent = {
        kind: 'driver_multi_comparison',
        season: 2025,
        driver_ids: ['max_verstappen', 'lando_norris'],
        comparison_metric: 'avg_true_pace'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.metadata.sql_template_id).toBe('driver_multi_comparison_v1');
      }
    });
  });
});

function validateErrorStructure(response: QueryError): void {
  expect(response.error).toBeDefined();
  expect(['intent_resolution_failed', 'validation_failed', 'execution_failed']).toContain(response.error);
  expect(response.reason).toBeDefined();
}
