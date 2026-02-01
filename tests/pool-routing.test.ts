import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPrimaryPool,
  createReplicaPool,
  getPoolConnectionInfo,
  createPool,
  getConnectionInfo
} from '../src/db/pool';

describe('Pool Routing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getPoolConnectionInfo', () => {
    it('indicates when using separate replica', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      process.env.DATABASE_URL_REPLICA = 'postgresql://replica:5432/f1db';

      const info = getPoolConnectionInfo();

      expect(info.using_replica).toBe(true);
      expect(info.primary.host).toContain('primary');
      expect(info.replica.host).toContain('replica');
    });

    it('falls back to primary when no replica configured', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      delete process.env.DATABASE_URL_REPLICA;

      const info = getPoolConnectionInfo();

      expect(info.using_replica).toBe(false);
      expect(info.primary.host).toContain('primary');
      expect(info.replica.host).toContain('primary'); // Falls back to primary
    });

    it('detects SSL from connection string', () => {
      process.env.DATABASE_URL = 'postgresql://host:5432/f1db?sslmode=require';
      delete process.env.DATABASE_URL_REPLICA;

      const info = getPoolConnectionInfo();

      expect(info.primary.ssl).toBe(true);
    });

    it('detects no SSL when not specified', () => {
      process.env.DATABASE_URL = 'postgresql://host:5432/f1db';
      delete process.env.DATABASE_URL_REPLICA;

      const info = getPoolConnectionInfo();

      expect(info.primary.ssl).toBe(false);
    });
  });

  describe('createPrimaryPool', () => {
    it('uses DATABASE_URL', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      process.env.DATABASE_URL_REPLICA = 'postgresql://replica:5432/f1db';

      // Pool creation uses the primary URL
      const pool = createPrimaryPool({ connectionTimeoutMillis: 100 });

      // Verify pool was created (we can't easily check the connection string)
      expect(pool).toBeDefined();
      expect(typeof pool.query).toBe('function');

      pool.end();
    });
  });

  describe('createReplicaPool', () => {
    it('uses DATABASE_URL_REPLICA when available', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      process.env.DATABASE_URL_REPLICA = 'postgresql://replica:5432/f1db';

      const pool = createReplicaPool({ connectionTimeoutMillis: 100 });

      expect(pool).toBeDefined();
      expect(typeof pool.query).toBe('function');

      pool.end();
    });

    it('falls back to DATABASE_URL when no replica configured', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      delete process.env.DATABASE_URL_REPLICA;

      const pool = createReplicaPool({ connectionTimeoutMillis: 100 });

      expect(pool).toBeDefined();
      expect(typeof pool.query).toBe('function');

      pool.end();
    });
  });

  describe('Pool separation logic', () => {
    it('creates separate pools for read and write operations', () => {
      process.env.DATABASE_URL = 'postgresql://primary:5432/f1db';
      process.env.DATABASE_URL_REPLICA = 'postgresql://replica:5432/f1db';

      const primaryPool = createPrimaryPool({ connectionTimeoutMillis: 100 });
      const replicaPool = createReplicaPool({ connectionTimeoutMillis: 100 });

      // Both pools should be defined
      expect(primaryPool).toBeDefined();
      expect(replicaPool).toBeDefined();

      // They should be different pool instances
      expect(primaryPool).not.toBe(replicaPool);

      primaryPool.end();
      replicaPool.end();
    });
  });
});

describe('Legacy pool functions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createPool (legacy)', () => {
    it('creates a pool from DATABASE_URL', () => {
      process.env.DATABASE_URL = 'postgresql://host:5432/f1db';

      const pool = createPool({ connectionTimeoutMillis: 100 });

      expect(pool).toBeDefined();
      expect(typeof pool.query).toBe('function');

      pool.end();
    });
  });

  describe('getConnectionInfo (legacy)', () => {
    it('returns connection info for primary', () => {
      process.env.DATABASE_URL = 'postgresql://host:5432/f1db?sslmode=require';

      const info = getConnectionInfo();

      expect(info.host).toBe('host');
      expect(info.ssl).toBe(true);
    });
  });
});

describe('SSL configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('detects SSL from sslmode=require', () => {
    process.env.DATABASE_URL = 'postgresql://host:5432/f1db?sslmode=require';

    const info = getPoolConnectionInfo();

    expect(info.primary.ssl).toBe(true);
  });

  it('detects SSL for Supabase URLs', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@db.abcdef.supabase.co:5432/postgres';

    const info = getPoolConnectionInfo();

    expect(info.primary.ssl).toBe(true);
  });

  it('does not detect SSL from sslmode=prefer (only sslmode=require supported)', () => {
    // Note: Current implementation only checks for sslmode=require specifically
    process.env.DATABASE_URL = 'postgresql://host:5432/f1db?sslmode=prefer';

    const info = getPoolConnectionInfo();

    expect(info.primary.ssl).toBe(false);
  });

  it('detects no SSL when sslmode not specified', () => {
    process.env.DATABASE_URL = 'postgresql://host:5432/f1db';

    const info = getPoolConnectionInfo();

    expect(info.primary.ssl).toBe(false);
  });

  it('detects no SSL when sslmode=disable', () => {
    process.env.DATABASE_URL = 'postgresql://host:5432/f1db?sslmode=disable';

    const info = getPoolConnectionInfo();

    expect(info.primary.ssl).toBe(false);
  });
});

describe('Database URL parsing', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('extracts host from connection string', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@db.example.com:5432/f1db';

    const info = getConnectionInfo();

    expect(info.host).toBe('db.example.com');
  });

  it('handles IPv4 addresses', () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@192.168.1.100:5432/f1db';

    const info = getConnectionInfo();

    expect(info.host).toBe('192.168.1.100');
  });

  it('handles localhost', () => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/f1db';

    const info = getConnectionInfo();

    expect(info.host).toBe('localhost');
  });

  it('returns unknown for invalid connection string', () => {
    process.env.DATABASE_URL = 'invalid-connection-string';

    const info = getConnectionInfo();

    expect(info.host).toBe('unknown');
  });
});
