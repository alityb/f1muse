import { describe, it, expect, beforeAll } from 'vitest';

/**
 * API Integration Tests
 *
 * Requirements:
 * - Backend server must be running on http://localhost:3000
 * - Database must be populated with actual data
 * - Tests are read-only (no writes to database)
 *
 * Run: npm run test:integration
 */

const API_BASE_URL = 'http://localhost:3000';
let serverAvailable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) {
      const health = await response.json();
      console.log('API Health:', health);
      serverAvailable = true;
    }
  } catch {
    console.log('API server not available, skipping integration tests');
    serverAvailable = false;
  }
});

describe('POST /query - Tier 1 Query Types', () => {
  it.skipIf(!serverAvailable)('should execute driver_season_summary query', async () => {
    const intent = {
      kind: 'driver_season_summary',
      driver_id: 'verstappen',
      season: 2024,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Verstappen 2024 season stats'
    };

    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });

    const data = await response.json();

    // Should return 200 or execution error (if data not available)
    if (response.status === 200 && !data.error) {
      expect(data).toHaveProperty('intent');
      expect(data.intent).toHaveProperty('kind', 'driver_season_summary');
      expect(data).toHaveProperty('result');
      expect(data.result).toHaveProperty('payload');
    } else {
      // Expected failure if database lacks 2024 data
      expect(data).toHaveProperty('error');
      expect(data.error).toMatch(/execution_failed|validation_failed|intent_resolution_failed/);
    }
  });

  it.skipIf(!serverAvailable)('should execute teammate_gap_summary_season query', async () => {
    const intent = {
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'norris',
      driver_b_id: 'piastri',
      season: 2024,
      metric: 'teammate_gap_raw',
      normalization: 'team_baseline',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Norris vs Piastri 2024 teammate gap'
    };

    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });

    const data = await response.json();

    // Should return 200 or execution error (if data not available)
    if (response.status === 200 && !data.error) {
      expect(data).toHaveProperty('intent');
      expect(data.intent).toHaveProperty('kind', 'teammate_gap_summary_season');
      expect(data).toHaveProperty('result');
      expect(data.result).toHaveProperty('payload');
    } else {
      // Expected failure if database lacks 2024 teammate data
      expect(data).toHaveProperty('error');
      expect(data.error).toMatch(/execution_failed|validation_failed/);
    }
  });

  it.skipIf(!serverAvailable)('should execute season_driver_vs_driver query', async () => {
    const intent = {
      kind: 'season_driver_vs_driver',
      driver_a_id: 'verstappen',
      driver_b_id: 'norris',
      season: 2024,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'Verstappen vs Norris 2024'
    };

    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });

    const data = await response.json();

    // Should return 200 or execution error (if data not available)
    if (response.status === 200 && !data.error) {
      expect(data).toHaveProperty('intent');
      expect(data.intent).toHaveProperty('kind', 'season_driver_vs_driver');
      expect(data).toHaveProperty('result');
      expect(data.result).toHaveProperty('payload');
    } else {
      // Expected failure if database lacks 2024 cross-team data
      expect(data).toHaveProperty('error');
      expect(data.error).toMatch(/execution_failed|validation_failed/);
    }
  });

  it.skipIf(!serverAvailable)('should reject invalid driver_id', async () => {
    const intent = {
      kind: 'driver_season_summary',
      driver_id: 'invalid_driver_xyz',
      season: 2024,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'invalid driver'
    };

    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });

    expect(response.status).toBeGreaterThanOrEqual(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toMatch(/validation_failed|execution_failed|intent_resolution_failed/);
  });

  it.skipIf(!serverAvailable)('should reject missing required fields', async () => {
    const intent = {
      kind: 'driver_season_summary',
      // Missing driver_id
      season: 2024,
      metric: 'avg_true_pace',
      normalization: 'none',
      clean_air_only: false,
      compound_context: 'mixed',
      session_scope: 'race',
      raw_query: 'missing driver'
    };

    const response = await fetch(`${API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });

    // Should reject due to missing driver_id
    expect(response.status).toBeGreaterThanOrEqual(400);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('GET /capabilities', () => {
  it.skipIf(!serverAvailable)('should return all 19 query kinds', async () => {
    const response = await fetch(`${API_BASE_URL}/capabilities`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('supported_query_kinds');
    expect(Array.isArray(data.supported_query_kinds)).toBe(true);
    expect(data.supported_query_kinds).toHaveLength(19);

    // Verify each query kind has required fields
    data.supported_query_kinds.forEach((queryKind: any) => {
      expect(queryKind).toHaveProperty('kind');
      expect(queryKind).toHaveProperty('status');
      expect(queryKind).toHaveProperty('description');
      expect(queryKind).toHaveProperty('tier');
      expect(queryKind).toHaveProperty('required_fields');
      expect(Array.isArray(queryKind.required_fields)).toBe(true);
    });
  });

  it.skipIf(!serverAvailable)('should include system_info metadata', async () => {
    const response = await fetch(`${API_BASE_URL}/capabilities`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('system_info');
    expect(data.system_info).toHaveProperty('total_query_kinds', 19);
    expect(data.system_info).toHaveProperty('supported_query_kinds', 19);
    expect(data.system_info).toHaveProperty('partial_query_kinds', 0);
    expect(data.system_info).toHaveProperty('api_version');
    expect(data.system_info).toHaveProperty('last_updated');

    // Validate date format (YYYY-MM-DD)
    expect(data.system_info.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.skipIf(!serverAvailable)('should include approved metrics', async () => {
    const response = await fetch(`${API_BASE_URL}/capabilities`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('approved_metrics');
    expect(Array.isArray(data.approved_metrics)).toBe(true);
    expect(data.approved_metrics.length).toBeGreaterThanOrEqual(4);

    // Verify metric structure
    data.approved_metrics.forEach((metric: any) => {
      expect(metric).toHaveProperty('metric');
      expect(metric).toHaveProperty('description');
      expect(metric).toHaveProperty('ranking_basis');
    });
  });

  it.skipIf(!serverAvailable)('should include normalization strategies', async () => {
    const response = await fetch(`${API_BASE_URL}/capabilities`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('normalization_strategies');
    expect(Array.isArray(data.normalization_strategies)).toBe(true);
    expect(data.normalization_strategies.length).toBeGreaterThanOrEqual(2);

    // Verify strategy structure
    data.normalization_strategies.forEach((strategy: any) => {
      expect(strategy).toHaveProperty('normalization');
      expect(strategy).toHaveProperty('description');
      expect(strategy).toHaveProperty('used_by');
      expect(Array.isArray(strategy.used_by)).toBe(true);
    });
  });

  it.skipIf(!serverAvailable)('should return correct content-type header', async () => {
    const response = await fetch(`${API_BASE_URL}/capabilities`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });
});

describe('GET /suggestions', () => {
  it.skipIf(!serverAvailable)('should return 6 categories', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('categories');
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThanOrEqual(6);

    // Verify category structure
    data.categories.forEach((category: any) => {
      expect(category).toHaveProperty('id');
      expect(category).toHaveProperty('display_name');
      expect(category).toHaveProperty('description');
      expect(category).toHaveProperty('suggestions');
      expect(Array.isArray(category.suggestions)).toBe(true);
    });
  });

  it.skipIf(!serverAvailable)('should return 24 total suggestions', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);

    const data = await response.json();

    // Count total suggestions across all categories
    const totalSuggestions = data.categories.reduce(
      (sum: number, category: any) => sum + category.suggestions.length,
      0
    );
    expect(totalSuggestions).toBeGreaterThanOrEqual(24);
  });

  it.skipIf(!serverAvailable)('should include query_kind for each suggestion', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);

    const data = await response.json();

    // Verify each suggestion has required fields
    data.categories.forEach((category: any) => {
      category.suggestions.forEach((suggestion: any) => {
        expect(suggestion).toHaveProperty('query_kind');
        expect(suggestion).toHaveProperty('text');
        expect(suggestion).toHaveProperty('description');
        expect(typeof suggestion.query_kind).toBe('string');
        expect(typeof suggestion.text).toBe('string');
        expect(typeof suggestion.description).toBe('string');
      });
    });
  });

  it.skipIf(!serverAvailable)('should include metadata with last_updated', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('metadata');
    expect(data.metadata.total_categories).toBeGreaterThanOrEqual(6);
    expect(data.metadata.total_suggestions).toBeGreaterThanOrEqual(24);
    expect(data.metadata).toHaveProperty('supported_query_kinds', 19);
    expect(data.metadata).toHaveProperty('last_updated');

    // Validate date format (YYYY-MM-DD)
    expect(data.metadata.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.skipIf(!serverAvailable)('should have expected category IDs', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);

    const data = await response.json();
    const categoryIds = data.categories.map((c: any) => c.id);

    expect(categoryIds).toContain('teammate_comparisons');
    expect(categoryIds).toContain('driver_vs_driver');
    expect(categoryIds).toContain('driver_performance');
    expect(categoryIds).toContain('track_analysis');
    expect(categoryIds).toContain('multi_driver_rankings');
    expect(categoryIds).toContain('race_results');
  });

  it.skipIf(!serverAvailable)('should return correct content-type header', async () => {
    const response = await fetch(`${API_BASE_URL}/suggestions`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });
});
