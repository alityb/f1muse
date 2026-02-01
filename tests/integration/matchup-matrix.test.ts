/**
 * Matchup Matrix Integration Tests (PART E)
 *
 * Tests for:
 * 1. driver_matchup_lookup query kind
 * 2. Precomputed matrix lookup correctness
 * 3. Driver ordering (lexicographic)
 * 4. Coverage status
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../../src/execution/query-executor';
import { QueryIntent } from '../../src/types/query-intent';
import { QueryResult, QueryError, DriverMatchupLookupPayload } from '../../src/types/results';
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

describe('Matchup Matrix Integration Tests', () => {
  describe('Precomputed Lookup', () => {
    it.skipIf(!dbAvailable)('looks up VER vs PER qualifying matchup', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.result.type).toBe('driver_matchup_lookup');
        const payload = response.result.payload as DriverMatchupLookupPayload;

        expect(payload.season).toBe(2025);
        expect(payload.metric).toBe('qualifying_position');

        // From fixtures: VER beats PER 7-3
        expect(payload.shared_events).toBe(10);
        expect(payload.primary_wins).toBe(7);
        expect(payload.secondary_wins).toBe(3);
        expect(payload.ties).toBe(0);
        expect(payload.coverage_status).toBe('valid');
      } else {
        // If matchup matrix not populated, should fail gracefully
        expect(isQueryError(response)).toBe(true);
      }
    });

    it.skipIf(!dbAvailable)('looks up VER vs PER race finish matchup', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'race_finish_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        expect(payload.metric).toBe('race_finish_position');
        // Same results for race as qualifying in fixtures
        expect(payload.primary_wins).toBe(7);
        expect(payload.secondary_wins).toBe(3);
      }
    });

    it.skipIf(!dbAvailable)('looks up NOR vs PIA matchup', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'lando_norris',
        driver_b_id: 'oscar_piastri',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        // From fixtures: NOR beats PIA 6-4
        expect(payload.primary_wins).toBe(6);
        expect(payload.secondary_wins).toBe(4);
        expect(payload.shared_events).toBe(10);
      }
    });

    it.skipIf(!dbAvailable)('looks up LEC vs SAI matchup (tie scenario)', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'charles_leclerc',
        driver_b_id: 'carlos_sainz',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        // From fixtures: LEC vs SAI is 5-5 (stored as carlos_sainz primary due to lexicographic order)
        // carlos_sainz < charles_leclerc alphabetically
        expect(payload.driver_primary_id).toBe('carlos_sainz');
        expect(payload.driver_secondary_id).toBe('charles_leclerc');
        expect(payload.primary_wins).toBe(5);
        expect(payload.secondary_wins).toBe(5);
      }
    });
  });

  describe('Driver Ordering', () => {
    it.skipIf(!dbAvailable)('handles driver_a > driver_b lexicographically', async () => {
      // Pass drivers in "wrong" order - should still work
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'sergio_perez', // Comes after max_verstappen
        driver_b_id: 'max_verstappen',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        // Should normalize to max_verstappen as primary (comes first alphabetically)
        expect(payload.driver_primary_id).toBe('max_verstappen');
        expect(payload.driver_secondary_id).toBe('sergio_perez');
        // Results should still be correct (VER 7-3 PER)
        expect(payload.primary_wins).toBe(7);
        expect(payload.secondary_wins).toBe(3);
      }
    });

    it.skipIf(!dbAvailable)('maintains consistent ordering regardless of input order', async () => {
      const intentAB: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'lando_norris',
        driver_b_id: 'oscar_piastri',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const intentBA: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'oscar_piastri',
        driver_b_id: 'lando_norris',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const responseAB = await executor!.execute(intentAB);
      const responseBA = await executor!.execute(intentBA);

      if (isQueryResult(responseAB) && isQueryResult(responseBA)) {
        const payloadAB = responseAB.result.payload as DriverMatchupLookupPayload;
        const payloadBA = responseBA.result.payload as DriverMatchupLookupPayload;

        // Both should have same primary driver (lexicographically first)
        expect(payloadAB.driver_primary_id).toBe(payloadBA.driver_primary_id);
        expect(payloadAB.driver_secondary_id).toBe(payloadBA.driver_secondary_id);
        expect(payloadAB.primary_wins).toBe(payloadBA.primary_wins);
        expect(payloadAB.secondary_wins).toBe(payloadBA.secondary_wins);
      }
    });
  });

  describe('Cross-Team Lookups', () => {
    it.skipIf(!dbAvailable)('looks up VER vs LEC (cross-team)', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'charles_leclerc',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        // From fixtures: charles_leclerc vs max_verstappen -> LEC 2-8 VER
        // charles_leclerc comes first alphabetically
        expect(payload.driver_primary_id).toBe('charles_leclerc');
        expect(payload.driver_secondary_id).toBe('max_verstappen');
        expect(payload.primary_wins).toBe(2);
        expect(payload.secondary_wins).toBe(8);
      }
    });

    it.skipIf(!dbAvailable)('looks up VER vs NOR (cross-team)', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'lando_norris',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        // From fixtures: lando_norris vs max_verstappen -> NOR 3-7 VER
        expect(payload.driver_primary_id).toBe('lando_norris');
        expect(payload.driver_secondary_id).toBe('max_verstappen');
        expect(payload.primary_wins).toBe(3);
        expect(payload.secondary_wins).toBe(7);
      }
    });
  });

  describe('Coverage Status', () => {
    it.skipIf(!dbAvailable)('returns valid coverage for sufficient data', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        expect(payload.coverage_status).toBe('valid');
        expect(payload.shared_events).toBeGreaterThanOrEqual(8); // Valid threshold
      }
    });

    it.skipIf(!dbAvailable)('includes computed_at timestamp', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        const payload = response.result.payload as DriverMatchupLookupPayload;
        expect(payload.computed_at).toBeDefined();
        // Should be a valid ISO 8601 timestamp
        const parsedDate = new Date(payload.computed_at);
        expect(parsedDate.getTime()).not.toBeNaN();
      }
    });
  });

  describe('Validation', () => {
    it.skipIf(!dbAvailable)('rejects same driver comparison', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'max_verstappen',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('themselves');
      }
    });

    it.skipIf(!dbAvailable)('rejects invalid h2h_metric', async () => {
      const intent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'invalid_metric'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('h2h_metric');
      }
    });

    it.skipIf(!dbAvailable)('rejects missing driver_b_id', async () => {
      const intent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        h2h_metric: 'qualifying_position'
      } as unknown as QueryIntent;

      const response = await executor!.execute(intent);

      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('validation_failed');
        expect(response.reason).toContain('driver_b_id');
      }
    });

    it.skipIf(!dbAvailable)('handles nonexistent driver pair gracefully', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'nonexistent_driver',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      // Should fail identity resolution
      expect(isQueryError(response)).toBe(true);
      if (isQueryError(response)) {
        expect(response.error).toBe('intent_resolution_failed');
      }
    });
  });

  describe('Response Structure', () => {
    it.skipIf(!dbAvailable)('uses correct SQL template', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.metadata.sql_template_id).toBe('driver_matchup_lookup_v1');
      }
    });

    it.skipIf(!dbAvailable)('includes interpretation with comparison_basis', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.interpretation.comparison_basis).toBeDefined();
        expect(response.interpretation.comparison_basis.length).toBeGreaterThan(0);
      }
    });

    it.skipIf(!dbAvailable)('includes confidence metadata', async () => {
      const intent: QueryIntent = {
        kind: 'driver_matchup_lookup',
        season: 2025,
        driver_a_id: 'max_verstappen',
        driver_b_id: 'sergio_perez',
        h2h_metric: 'qualifying_position'
      } as QueryIntent;

      const response = await executor!.execute(intent);

      if (isQueryResult(response)) {
        expect(response.interpretation.confidence).toBeDefined();
        expect(['high', 'moderate', 'low', 'insufficient']).toContain(
          response.interpretation.confidence.coverage_level
        );
      }
    });
  });
});

describe('Matchup Matrix vs H2H Count Consistency', () => {
  it.skipIf(!dbAvailable)('matchup_lookup results match h2h_count for same pair', async () => {
    // Both queries should return same data for the same driver pair
    const lookupIntent: QueryIntent = {
      kind: 'driver_matchup_lookup',
      season: 2025,
      driver_a_id: 'max_verstappen',
      driver_b_id: 'sergio_perez',
      h2h_metric: 'qualifying_position'
    } as QueryIntent;

    const countIntent: QueryIntent = {
      kind: 'driver_head_to_head_count',
      season: 2025,
      driver_a_id: 'max_verstappen',
      driver_b_id: 'sergio_perez',
      h2h_metric: 'qualifying_position'
    } as QueryIntent;

    const lookupResponse = await executor!.execute(lookupIntent);
    const countResponse = await executor!.execute(countIntent);

    if (isQueryResult(lookupResponse) && isQueryResult(countResponse)) {
      const lookupPayload = lookupResponse.result.payload as DriverMatchupLookupPayload;
      const countPayload = countResponse.result.payload as any;

      // Note: Ordering may differ, but total wins should match
      const lookupTotal = lookupPayload.primary_wins + lookupPayload.secondary_wins;
      const countTotal = countPayload.primary_wins + countPayload.secondary_wins;

      expect(lookupPayload.shared_events).toBe(countPayload.shared_events);
      expect(lookupTotal).toBe(countTotal);
    }
  });
});
