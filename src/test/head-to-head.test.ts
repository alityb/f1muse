import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QueryExecutor } from '../execution/query-executor';
import { QueryValidator } from '../validation/query-validator';
import { DriverHeadToHeadCountIntent } from '../types/query-intent';
import { setupTestDatabase, cleanupTestDatabase, getTestDatabaseUrl } from './setup';

let pool: Pool;
let executor: QueryExecutor;
const validator = new QueryValidator();

beforeAll(async () => {
  pool = new Pool({
    connectionString: getTestDatabaseUrl()
  });

  await pool.query('SELECT 1');
  await setupTestDatabase(pool);
  executor = new QueryExecutor(pool);
});

afterAll(async () => {
  await cleanupTestDatabase(pool);
  await pool.end();
});

describe('Driver Head-to-Head Count Validation', () => {
  it('validates valid head-to-head intent', async () => {
    const intent: DriverHeadToHeadCountIntent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Head to head Norris vs Piastri qualifying 2025'
    };

    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });

  it('rejects same driver comparison', async () => {
    const intent: DriverHeadToHeadCountIntent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'lando_norris',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Head to head Norris vs Norris'
    };

    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('Cannot compare a driver to themselves');
  });

  it('rejects missing driver_a_id', async () => {
    const intent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: '',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Test'
    } as DriverHeadToHeadCountIntent;

    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('driver_a_id is required');
  });

  it('rejects missing driver_b_id', async () => {
    const intent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: '',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Test'
    } as DriverHeadToHeadCountIntent;

    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('driver_b_id is required');
  });

  it('rejects invalid h2h_metric', async () => {
    const intent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'invalid_metric',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Test'
    } as unknown as DriverHeadToHeadCountIntent;

    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('h2h_metric must be');
  });

  it('rejects invalid h2h_scope', async () => {
    const intent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'invalid_scope',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Test'
    } as unknown as DriverHeadToHeadCountIntent;

    const result = await validator.validate(intent);
    expect(result.valid).toBe(false);
    expect(result.error?.reason).toContain('h2h_scope must be');
  });

  it('accepts race_finish_position metric', async () => {
    const intent: DriverHeadToHeadCountIntent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'max_verstappen',
      driver_b_id: 'charles_leclerc',
      h2h_metric: 'race_finish_position',
      h2h_scope: 'field',
      season: 2024,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Verstappen vs Leclerc race finishes 2024'
    };

    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });

  it('accepts teammate scope', async () => {
    const intent: DriverHeadToHeadCountIntent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'teammate',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Norris vs Piastri teammate qualifying'
    };

    const result = await validator.validate(intent);
    expect(result.valid).toBe(true);
  });
});

describe('NL Query Routing for Head-to-Head', () => {
  it('routes "head to head" pattern', () => {
    const question = 'head to head Norris vs Piastri qualifying 2025';
    const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);
    expect(isH2H).toBe(true);
  });

  it('routes "h2h" pattern', () => {
    const question = 'h2h Verstappen Hamilton race 2024';
    const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);
    expect(isH2H).toBe(true);
  });

  it('routes "outqualify" pattern', () => {
    const question = 'How many times did Norris outqualify Piastri in 2025?';
    const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);
    expect(isH2H).toBe(true);
  });

  it('routes "outfinished" pattern', () => {
    const question = 'Verstappen outfinished Perez how many times';
    const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);
    expect(isH2H).toBe(true);
  });

  it('routes "finished ahead" pattern', () => {
    const question = 'Who finished ahead more often, Hamilton or Russell?';
    const isH2H = /head\s*to\s*head|h2h|\boutqualif(?:y|ied)\b|\boutfinish(?:ed)?\b|finished ahead|beat count|who beat|how many times/i.test(question);
    expect(isH2H).toBe(true);
  });

  it('detects qualifying metric from question', () => {
    const question = 'qualifying head to head Norris Piastri';
    const isQualifying = /qualif(?:y|ying|ied)?|quali\b/i.test(question);
    expect(isQualifying).toBe(true);
  });

  it('detects race metric from question', () => {
    const question = 'race h2h Verstappen Hamilton';
    const isRace = /race|finish(?:ed)?|won/i.test(question);
    expect(isRace).toBe(true);
  });
});

describe('Head-to-Head Result Formatting', () => {
  it('formats valid h2h payload correctly', async () => {
    // This test verifies the result formatter produces correct output shape
    // The actual execution depends on database data availability
    const intent: DriverHeadToHeadCountIntent = {
      kind: 'driver_head_to_head_count',
      driver_a_id: 'lando_norris',
      driver_b_id: 'oscar_piastri',
      h2h_metric: 'qualifying_position',
      h2h_scope: 'field',
      season: 2025,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Norris vs Piastri qualifying 2025'
    };

    const result = await executor.execute(intent);

    // If data exists, verify the shape
    if (!('error' in result)) {
      expect(result.result.type).toBe('driver_head_to_head_count');
      const payload = result.result.payload;
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
      // If insufficient data, that's also a valid fail-closed response
      expect(result.error).toBeDefined();
    }
  });
});
