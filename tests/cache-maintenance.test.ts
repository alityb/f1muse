import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  CacheMaintenance,
  runCacheMaintenance,
  startCacheMaintenanceInterval,
  MaintenanceResult
} from '../src/cache/maintenance';
import { METHODOLOGY_VERSION, SCHEMA_VERSION } from '../src/config/versioning';

// Test database setup
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/f1muse_test';

let pool: Pool | null = null;
let dbAvailable = false;

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
  } catch (error) {
    console.log('Test database not available, skipping CacheMaintenance database tests');
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

// Helper to insert test cache entries
async function insertCacheEntry(
  pool: Pool,
  options: {
    cache_key: string;
    expires_at?: Date | null;
    methodology_version?: string;
    schema_version?: string;
    created_at?: Date;
    last_hit_at?: Date | null;
    confidence_level?: 'valid' | 'low_coverage' | 'insufficient';
  }
) {
  const {
    cache_key,
    expires_at = null,
    methodology_version = METHODOLOGY_VERSION,
    schema_version = SCHEMA_VERSION,
    created_at = new Date(),
    last_hit_at = null,
    confidence_level = 'valid'
  } = options;

  await pool.query(`
    INSERT INTO api_query_cache (
      cache_key, query_kind, query_hash, parameters, response,
      confidence_level, methodology_version, schema_version,
      created_at, expires_at, hit_count, last_hit_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `, [
    cache_key,
    'test_kind',
    'hash123',
    JSON.stringify({ test: true }),
    JSON.stringify({ data: 'test' }),
    confidence_level,
    methodology_version,
    schema_version,
    created_at,
    expires_at,
    0,
    last_hit_at
  ]);
}

describe('CacheMaintenance', () => {
  describe('purgeExpired', () => {
    it.skipIf(!dbAvailable)('removes expired entries', async () => {
      const maintenance = new CacheMaintenance(pool!);

      // Insert expired entry
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
      await insertCacheEntry(pool!, {
        cache_key: 'expired_entry',
        expires_at: pastDate
      });

      // Insert non-expired entry
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
      await insertCacheEntry(pool!, {
        cache_key: 'valid_entry',
        expires_at: futureDate
      });

      // Run purge
      const purged = await maintenance.purgeExpired();

      expect(purged).toBe(1);

      // Verify only valid entry remains
      const result = await pool!.query('SELECT cache_key FROM api_query_cache');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].cache_key).toBe('valid_entry');
    });

    it.skipIf(!dbAvailable)('keeps entries without expiration', async () => {
      const maintenance = new CacheMaintenance(pool!);

      // Insert entry without expiration
      await insertCacheEntry(pool!, {
        cache_key: 'no_expiry_entry',
        expires_at: null
      });

      // Run purge
      const purged = await maintenance.purgeExpired();

      expect(purged).toBe(0);

      // Verify entry remains
      const result = await pool!.query('SELECT cache_key FROM api_query_cache');
      expect(result.rows.length).toBe(1);
    });
  });

  describe('enforceMaxEntries', () => {
    it.skipIf(!dbAvailable)('evicts oldest entries when limit exceeded', async () => {
      const maintenance = new CacheMaintenance(pool!, { max_entries: 3, verbose: false });

      // Insert 5 entries with different ages
      const now = Date.now();
      for (let i = 1; i <= 5; i++) {
        await insertCacheEntry(pool!, {
          cache_key: `entry_${i}`,
          created_at: new Date(now - i * 1000 * 60), // Entry i is i minutes old
          last_hit_at: new Date(now - i * 1000 * 60)
        });
      }

      // Enforce max 3 entries
      const evicted = await maintenance.enforceMaxEntries(3);

      expect(evicted).toBe(2);

      // Verify only 3 newest entries remain (entry_1, entry_2, entry_3)
      const result = await pool!.query(
        'SELECT cache_key FROM api_query_cache ORDER BY cache_key'
      );
      expect(result.rows.length).toBe(3);
      expect(result.rows.map(r => r.cache_key)).toEqual(['entry_1', 'entry_2', 'entry_3']);
    });

    it.skipIf(!dbAvailable)('does nothing when under limit', async () => {
      const maintenance = new CacheMaintenance(pool!, { max_entries: 10, verbose: false });

      // Insert 3 entries
      for (let i = 1; i <= 3; i++) {
        await insertCacheEntry(pool!, { cache_key: `entry_${i}` });
      }

      // Enforce max 10 entries
      const evicted = await maintenance.enforceMaxEntries();

      expect(evicted).toBe(0);

      // Verify all entries remain
      const result = await pool!.query('SELECT COUNT(*) as count FROM api_query_cache');
      expect(parseInt(result.rows[0].count, 10)).toBe(3);
    });

    it.skipIf(!dbAvailable)('uses last_hit_at for LRU ordering', async () => {
      const maintenance = new CacheMaintenance(pool!, { max_entries: 2, verbose: false });

      const now = Date.now();

      // Entry 1: old creation, recent hit
      await insertCacheEntry(pool!, {
        cache_key: 'recently_hit',
        created_at: new Date(now - 10 * 60 * 1000), // 10 min old
        last_hit_at: new Date(now - 1 * 60 * 1000)  // hit 1 min ago
      });

      // Entry 2: recent creation, no hit
      await insertCacheEntry(pool!, {
        cache_key: 'never_hit',
        created_at: new Date(now - 5 * 60 * 1000),  // 5 min old
        last_hit_at: null
      });

      // Entry 3: old creation, old hit
      await insertCacheEntry(pool!, {
        cache_key: 'old_hit',
        created_at: new Date(now - 15 * 60 * 1000), // 15 min old
        last_hit_at: new Date(now - 15 * 60 * 1000) // hit 15 min ago
      });

      // Enforce max 2 entries
      const evicted = await maintenance.enforceMaxEntries();

      expect(evicted).toBe(1);

      // The oldest by COALESCE(last_hit_at, created_at) should be evicted
      // old_hit has COALESCE = 15 min ago
      // never_hit has COALESCE = 5 min ago (uses created_at)
      // recently_hit has COALESCE = 1 min ago
      const result = await pool!.query(
        'SELECT cache_key FROM api_query_cache ORDER BY cache_key'
      );
      expect(result.rows.length).toBe(2);
      expect(result.rows.map(r => r.cache_key)).toContain('recently_hit');
      expect(result.rows.map(r => r.cache_key)).not.toContain('old_hit');
    });
  });

  describe('purgeStaleVersions', () => {
    it.skipIf(!dbAvailable)('removes entries with old methodology version', async () => {
      const maintenance = new CacheMaintenance(pool!, { verbose: false });

      // Insert current version entry
      await insertCacheEntry(pool!, {
        cache_key: 'current_version',
        methodology_version: METHODOLOGY_VERSION,
        schema_version: SCHEMA_VERSION
      });

      // Insert old version entry
      await insertCacheEntry(pool!, {
        cache_key: 'old_methodology',
        methodology_version: 'old_methodology_v1',
        schema_version: SCHEMA_VERSION
      });

      // Insert old schema entry
      await insertCacheEntry(pool!, {
        cache_key: 'old_schema',
        methodology_version: METHODOLOGY_VERSION,
        schema_version: 'old_schema_v1'
      });

      // Purge stale versions
      const purged = await maintenance.purgeStaleVersions();

      expect(purged).toBe(2);

      // Verify only current version entry remains
      const result = await pool!.query('SELECT cache_key FROM api_query_cache');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].cache_key).toBe('current_version');
    });
  });

  describe('getStats', () => {
    it.skipIf(!dbAvailable)('returns correct statistics', async () => {
      const maintenance = new CacheMaintenance(pool!, { verbose: false });

      // Insert mixed entries
      await insertCacheEntry(pool!, {
        cache_key: 'valid_1',
        confidence_level: 'valid'
      });

      await insertCacheEntry(pool!, {
        cache_key: 'valid_2',
        confidence_level: 'valid'
      });

      await insertCacheEntry(pool!, {
        cache_key: 'low_coverage_1',
        confidence_level: 'low_coverage'
      });

      // Insert expired entry
      await insertCacheEntry(pool!, {
        cache_key: 'expired_1',
        confidence_level: 'valid',
        expires_at: new Date(Date.now() - 1000)
      });

      const stats = await maintenance.getStats();

      expect(stats.total_entries).toBe(4);
      expect(stats.valid_entries).toBe(3); // 2 valid + 1 expired valid
      expect(stats.low_coverage_entries).toBe(1);
      expect(stats.expired_entries).toBe(1);
    });
  });

  describe('runAll', () => {
    it.skipIf(!dbAvailable)('runs all maintenance tasks in order', async () => {
      const maintenance = new CacheMaintenance(pool!, {
        max_entries: 2,
        verbose: false,
        vacuum_hint: true
      });

      // Insert stale version entry
      await insertCacheEntry(pool!, {
        cache_key: 'stale_1',
        methodology_version: 'old_v1'
      });

      // Insert expired entry
      await insertCacheEntry(pool!, {
        cache_key: 'expired_1',
        expires_at: new Date(Date.now() - 1000)
      });

      // Insert 3 valid entries (1 will be LRU evicted to get to max 2)
      const now = Date.now();
      for (let i = 1; i <= 3; i++) {
        await insertCacheEntry(pool!, {
          cache_key: `valid_${i}`,
          last_hit_at: new Date(now - i * 60 * 1000)
        });
      }

      const result = await maintenance.runAll();

      expect(result.stale_versions_removed).toBe(1);
      expect(result.expired_purged).toBe(1);
      expect(result.lru_evicted).toBe(1);
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);

      // Verify only 2 entries remain
      const dbResult = await pool!.query('SELECT COUNT(*) as count FROM api_query_cache');
      expect(parseInt(dbResult.rows[0].count, 10)).toBe(2);
    });

    it.skipIf(!dbAvailable)('suggests vacuum when many rows deleted', async () => {
      const maintenance = new CacheMaintenance(pool!, {
        max_entries: 250000,
        verbose: false,
        vacuum_hint: true
      });

      // The vacuum threshold is 10000 rows, but we can't easily test that
      // Just verify the field is present
      const result = await maintenance.runAll();

      expect(typeof result.vacuum_suggested).toBe('boolean');
    });
  });

  describe('runCacheMaintenance convenience function', () => {
    it.skipIf(!dbAvailable)('runs maintenance with provided pool', async () => {
      await insertCacheEntry(pool!, {
        cache_key: 'test_entry',
        expires_at: new Date(Date.now() - 1000) // expired
      });

      const result = await runCacheMaintenance(pool!, { verbose: false });

      expect(result.expired_purged).toBe(1);
    });
  });

  describe('startCacheMaintenanceInterval', () => {
    it.skipIf(!dbAvailable)('returns an interval that can be cleared', async () => {
      // Start with a very long interval so it doesn't actually run
      const interval = startCacheMaintenanceInterval(pool!, 60 * 60 * 1000, {
        verbose: false
      });

      expect(interval).toBeDefined();
      expect(typeof interval).toBe('object'); // NodeJS.Timeout

      // Clear the interval
      clearInterval(interval);

      // If we get here without error, the test passes
      expect(true).toBe(true);
    });
  });
});

describe('CacheMaintenance options', () => {
  it.skipIf(!dbAvailable)('respects max_entries option', async () => {
    const maintenance = new CacheMaintenance(pool!, {
      max_entries: 5,
      verbose: false
    });

    // Insert 7 entries
    for (let i = 1; i <= 7; i++) {
      const now = Date.now();
      await insertCacheEntry(pool!, {
        cache_key: `entry_${i}`,
        created_at: new Date(now - i * 1000)
      });
    }

    await maintenance.enforceMaxEntries();

    const result = await pool!.query('SELECT COUNT(*) as count FROM api_query_cache');
    expect(parseInt(result.rows[0].count, 10)).toBe(5);
  });

  it.skipIf(!dbAvailable)('uses default max_entries when not specified', async () => {
    const maintenance = new CacheMaintenance(pool!);

    // The default is 250,000 - just verify it doesn't evict with few entries
    await insertCacheEntry(pool!, { cache_key: 'test_entry' });

    const evicted = await maintenance.enforceMaxEntries();
    expect(evicted).toBe(0);
  });
});
