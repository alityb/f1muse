import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { CacheService, createCacheEntry, mapCoverageToConfidenceLevel } from '../src/cache/query-cache';
import { getCacheExpirationDate } from '../src/config/versioning';
import { QueryResult } from '../src/types/results';
import { DriverHeadToHeadCountIntent } from '../src/types/query-intent';

// Test database setup
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/f1muse_test';

let pool: Pool | null = null;
let cacheService: CacheService | null = null;
let dbAvailable = false;

// Mock QueryResult
function createMockQueryResult(confidenceLevel: 'high' | 'moderate' | 'low' | 'insufficient'): QueryResult {
  return {
    intent: {
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
      raw_query: 'test'
    } as DriverHeadToHeadCountIntent,
    result: {
      type: 'driver_head_to_head_count',
      payload: {
        type: 'driver_head_to_head_count',
        season: 2025,
        metric: 'qualifying_position',
        driver_primary_id: 'lando_norris',
        driver_secondary_id: 'oscar_piastri',
        shared_events: 10,
        primary_wins: 6,
        secondary_wins: 4,
        ties: 0,
        coverage_status: 'valid'
      }
    },
    interpretation: {
      comparison_basis: 'test',
      normalization_scope: 'test',
      metric_definition: 'test',
      constraints: {
        min_lap_requirement: 4,
        rows_included: 1,
        other_constraints: []
      },
      confidence_notes: [],
      confidence: {
        coverage_level: confidenceLevel,
        laps_considered: 10,
        notes: []
      }
    },
    metadata: {
      sql_template_id: 'driver_head_to_head_count_v1',
      data_scope: 'season-scoped: 2025',
      rows: 1
    }
  };
}

// Mock intent
function createMockIntent(): DriverHeadToHeadCountIntent {
  return {
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
    raw_query: 'test query'
  };
}

beforeAll(async () => {
  try {
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000
    });

    await pool.query('SELECT 1');
    dbAvailable = true;

    // Create cache table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_query_cache (
        cache_key TEXT PRIMARY KEY,
        query_kind TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        parameters JSONB NOT NULL,
        response JSONB NOT NULL,
        confidence_level TEXT NOT NULL CHECK (confidence_level IN ('valid', 'low_coverage', 'insufficient')),
        coverage_percent NUMERIC(5,2),
        shared_events INTEGER,
        methodology_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        expires_at TIMESTAMPTZ,
        hit_count INTEGER DEFAULT 0 NOT NULL,
        last_hit_at TIMESTAMPTZ
      )
    `);

    cacheService = new CacheService(pool);
  } catch (error) {
    console.log('Test database not available, skipping CacheService database tests');
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (pool && dbAvailable) {
    // Cleanup
    await pool.query('DROP TABLE IF EXISTS api_query_cache');
    await pool.end();
  }
});

beforeEach(async () => {
  if (pool && dbAvailable) {
    // Clear cache before each test
    await pool.query('TRUNCATE api_query_cache');
  }
});

describe('CacheService', () => {
  describe('computeCacheKey', () => {
    it.skipIf(!dbAvailable)('generates consistent cache keys for same parameters', () => {
      const params1 = { kind: 'test', parameters: { season: 2025, driver_id: 'norris' } };
      const params2 = { kind: 'test', parameters: { season: 2025, driver_id: 'norris' } };

      const key1 = cacheService!.computeCacheKey(params1);
      const key2 = cacheService!.computeCacheKey(params2);

      expect(key1).toBe(key2);
    });

    it.skipIf(!dbAvailable)('generates different keys for different parameters', () => {
      const params1 = { kind: 'test', parameters: { season: 2025 } };
      const params2 = { kind: 'test', parameters: { season: 2024 } };

      const key1 = cacheService!.computeCacheKey(params1);
      const key2 = cacheService!.computeCacheKey(params2);

      expect(key1).not.toBe(key2);
    });

    it.skipIf(!dbAvailable)('ignores raw_query in cache key', () => {
      const intent1 = createMockIntent();
      const intent2 = { ...createMockIntent(), raw_query: 'different query' };

      const params1 = cacheService!.extractCacheParameters(intent1);
      const params2 = cacheService!.extractCacheParameters(intent2);

      const key1 = cacheService!.computeCacheKey({ kind: intent1.kind, parameters: params1 });
      const key2 = cacheService!.computeCacheKey({ kind: intent2.kind, parameters: params2 });

      expect(key1).toBe(key2);
    });
  });

  describe('set and get', () => {
    it.skipIf(!dbAvailable)('stores and retrieves valid cache entries', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      // Store
      const stored = await cacheService!.set(entry);
      expect(stored).toBe(true);

      // Retrieve
      const lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(true);
      expect(lookup.entry).not.toBeNull();
      expect(lookup.entry?.query_kind).toBe('driver_head_to_head_count');
    });

    it.skipIf(!dbAvailable)('does not cache insufficient confidence results', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('insufficient');
      const entry = createCacheEntry(cacheService!, intent, result, 2);

      // Should return false for insufficient
      const stored = await cacheService!.set(entry);
      expect(stored).toBe(false);

      // Should not be in cache
      const lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(false);
    });

    it.skipIf(!dbAvailable)('returns cache miss for non-existent keys', async () => {
      const lookup = await cacheService!.get('non_existent_key_12345');
      expect(lookup.hit).toBe(false);
      expect(lookup.entry).toBeNull();
    });
  });

  describe('incrementHit', () => {
    it.skipIf(!dbAvailable)('increments hit count', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      await cacheService!.set(entry);

      // Increment hit
      await cacheService!.incrementHit(entry.cache_key);

      // Check hit count
      const lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.entry?.hit_count).toBe(1);
    });
  });

  describe('invalidateByKind', () => {
    it.skipIf(!dbAvailable)('removes all entries of a specific kind', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      await cacheService!.set(entry);

      // Verify entry exists
      let lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(true);

      // Invalidate by kind
      const deleted = await cacheService!.invalidateByKind('driver_head_to_head_count');
      expect(deleted).toBe(1);

      // Verify entry is gone
      lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(false);
    });
  });

  describe('purgeExpired', () => {
    it.skipIf(!dbAvailable)('removes expired entries', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      // Manually insert with expired timestamp
      await pool!.query(`
        INSERT INTO api_query_cache (
          cache_key, query_kind, query_hash, parameters, response,
          confidence_level, methodology_version, schema_version, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '1 day')
      `, [
        entry.cache_key,
        entry.query_kind,
        entry.query_hash,
        JSON.stringify(entry.parameters),
        JSON.stringify(entry.response),
        entry.confidence_level,
        entry.methodology_version,
        entry.schema_version
      ]);

      // Purge expired
      const purged = await cacheService!.purgeExpired();
      expect(purged).toBe(1);

      // Verify entry is gone
      const lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(false);
    });
  });

  describe('version invalidation', () => {
    it.skipIf(!dbAvailable)('does not return entries with different methodology version', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      // Insert with different methodology version
      await pool!.query(`
        INSERT INTO api_query_cache (
          cache_key, query_kind, query_hash, parameters, response,
          confidence_level, methodology_version, schema_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        entry.cache_key,
        entry.query_kind,
        entry.query_hash,
        JSON.stringify(entry.parameters),
        JSON.stringify(entry.response),
        entry.confidence_level,
        'old_version',  // Different version
        entry.schema_version
      ]);

      // Should not find entry due to version mismatch
      const lookup = await cacheService!.get(entry.cache_key);
      expect(lookup.hit).toBe(false);
    });

    it.skipIf(!dbAvailable)('invalidateStaleVersions removes entries with old versions', async () => {
      const intent = createMockIntent();
      const result = createMockQueryResult('high');
      const entry = createCacheEntry(cacheService!, intent, result, 10);

      // Insert with old version
      await pool!.query(`
        INSERT INTO api_query_cache (
          cache_key, query_kind, query_hash, parameters, response,
          confidence_level, methodology_version, schema_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        'old_version_key',
        entry.query_kind,
        entry.query_hash,
        JSON.stringify(entry.parameters),
        JSON.stringify(entry.response),
        entry.confidence_level,
        'old_methodology',
        'old_schema'
      ]);

      // Invalidate stale versions
      const deleted = await cacheService!.invalidateStaleVersions();
      expect(deleted).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('Cache TTL configuration', () => {
  it('valid confidence gets 30-day TTL', () => {
    const expiresAt = getCacheExpirationDate('valid');
    expect(expiresAt).not.toBeNull();
    const diffDays = Math.round((expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(30);
  });

  it('low_coverage confidence gets 1-hour TTL', () => {
    const expiresAt = getCacheExpirationDate('low_coverage');
    expect(expiresAt).not.toBeNull();
    const diffHours = Math.round((expiresAt!.getTime() - Date.now()) / (60 * 60 * 1000));
    expect(diffHours).toBe(1);
  });

  it('insufficient confidence gets no TTL (not cached)', () => {
    const expiresAt = getCacheExpirationDate('insufficient');
    expect(expiresAt).toBeNull();
  });
});

describe('mapCoverageToConfidenceLevel', () => {
  it('maps valid to valid', () => {
    expect(mapCoverageToConfidenceLevel('valid')).toBe('valid');
  });

  it('maps low_coverage to low_coverage', () => {
    expect(mapCoverageToConfidenceLevel('low_coverage')).toBe('low_coverage');
  });

  it('maps insufficient to insufficient', () => {
    expect(mapCoverageToConfidenceLevel('insufficient')).toBe('insufficient');
  });

  it('maps unknown to insufficient', () => {
    expect(mapCoverageToConfidenceLevel('unknown')).toBe('insufficient');
  });
});

describe('CacheService.getStats', () => {
  it.skipIf(!dbAvailable)('returns correct statistics', async () => {
    const intent = createMockIntent();
    const result = createMockQueryResult('high');
    const entry = createCacheEntry(cacheService!, intent, result, 10);

    await cacheService!.set(entry);

    const stats = await cacheService!.getStats();
    expect(stats.total_entries).toBeGreaterThanOrEqual(1);
    expect(stats.valid_entries).toBeGreaterThanOrEqual(1);
  });
});
