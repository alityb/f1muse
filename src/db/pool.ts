import { Pool, PoolConfig } from 'pg';

/**
 * Parse database URL to extract host for logging (no secrets)
 */
function parseDbHost(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return url.hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Check if connection string targets Supabase
 */
function isSupabaseUrl(connectionString: string): boolean {
  return connectionString.includes('supabase.co');
}

/**
 * Get the primary database URL (for writes)
 *
 * Checks DATABASE_URL_PRIMARY first, falls back to DATABASE_URL
 */
function getPrimaryDatabaseUrl(): string {
  const primaryUrl = process.env.DATABASE_URL_PRIMARY;
  if (primaryUrl && primaryUrl.trim().length > 0) {
    return primaryUrl;
  }
  return validateDatabaseUrl();
}

/**
 * Get the replica database URL (for reads)
 *
 * Checks DATABASE_URL_REPLICA first, falls back to primary URL
 */
function getReplicaDatabaseUrl(): string {
  const replicaUrl = process.env.DATABASE_URL_REPLICA;
  if (replicaUrl && replicaUrl.trim().length > 0) {
    return replicaUrl;
  }
  // Fall back to primary
  return getPrimaryDatabaseUrl();
}

/**
 * Validate DATABASE_URL is set and fail fast with actionable error
 */
function validateDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;

  if (!url || url.trim().length === 0) {
    console.error('\n' + '='.repeat(60));
    console.error('ERROR: DATABASE_URL is not set');
    console.error('='.repeat(60));
    console.error('\nTo fix this, either:');
    console.error('  1. Create a .env file with DATABASE_URL=postgresql://...');
    console.error('  2. Or export it directly:');
    console.error('     export DATABASE_URL="postgresql://user:pass@host:5432/db"');
    console.error('\nFor psql access, run:');
    console.error('     source .env && psql "$DATABASE_URL" -c "select 1;"');
    console.error('\n' + '='.repeat(60) + '\n');
    process.exit(1);
  }

  return url;
}

/**
 * Get connection info for logging (no secrets exposed)
 */
export function getConnectionInfo(): { host: string; ssl: boolean } {
  const url = process.env.DATABASE_URL || '';
  return {
    host: parseDbHost(url),
    ssl: isSupabaseUrl(url) || url.includes('sslmode=require')
  };
}

/**
 * Create PostgreSQL connection pool (READ-ONLY)
 *
 * - Fails fast if DATABASE_URL is not set
 * - Automatically enables SSL for Supabase connections
 * - Uses longer timeout for external databases
 */
export function createPool(config?: PoolConfig): Pool {
  const connectionString = validateDatabaseUrl();
  const useSSL = isSupabaseUrl(connectionString);

  const poolConfig: PoolConfig = config || {
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    // Longer timeout for external databases (Supabase)
    connectionTimeoutMillis: useSSL ? 10000 : 5000,
    // SSL configuration for Supabase
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  };

  const pool = new Pool(poolConfig);

  // Set READ-ONLY mode for all connections
  pool.on('connect', async (client) => {
    try {
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    } catch (err) {
      console.error('Failed to set READ ONLY mode:', err);
    }
  });

  pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
  });

  return pool;
}

/**
 * Create PostgreSQL connection pool with WRITE access (for caching)
 *
 * IMPORTANT: Only use this pool for cache operations.
 * All other operations should use the read-only pool.
 */
export function createWritePool(config?: PoolConfig): Pool {
  const connectionString = validateDatabaseUrl();
  const useSSL = isSupabaseUrl(connectionString);

  const poolConfig: PoolConfig = config || {
    connectionString,
    max: 5,  // Smaller pool for cache writes
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: useSSL ? 10000 : 5000,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  };

  const pool = new Pool(poolConfig);

  // No READ-ONLY mode for write pool

  pool.on('error', (err) => {
    console.error('Unexpected database error (write pool):', err);
  });

  return pool;
}

/**
 * Create PRIMARY PostgreSQL connection pool (for writes)
 *
 * Uses DATABASE_URL_PRIMARY if set, otherwise falls back to DATABASE_URL.
 * Used for: cache writes, ingestion, audit logs
 */
export function createPrimaryPool(config?: PoolConfig): Pool {
  const connectionString = getPrimaryDatabaseUrl();
  const useSSL = isSupabaseUrl(connectionString);

  const poolConfig: PoolConfig = config || {
    connectionString,
    max: 5,  // Smaller pool for writes
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: useSSL ? 10000 : 5000,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  };

  const pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    console.error('Unexpected database error (primary pool):', err);
  });

  return pool;
}

/**
 * Create REPLICA PostgreSQL connection pool (for reads)
 *
 * Uses DATABASE_URL_REPLICA if set, otherwise falls back to primary.
 * Used for: API query reads (SELECT only)
 */
export function createReplicaPool(config?: PoolConfig): Pool {
  const connectionString = getReplicaDatabaseUrl();
  const useSSL = isSupabaseUrl(connectionString);

  const poolConfig: PoolConfig = config || {
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: useSSL ? 10000 : 5000,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  };

  const pool = new Pool(poolConfig);

  // Set READ-ONLY mode for replica connections
  pool.on('connect', async (client) => {
    try {
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    } catch (err) {
      console.error('Failed to set READ ONLY mode on replica:', err);
    }
  });

  pool.on('error', (err) => {
    console.error('Unexpected database error (replica pool):', err);
  });

  return pool;
}

/**
 * Get connection info for both primary and replica (no secrets)
 */
export function getPoolConnectionInfo(): {
  primary: { host: string; ssl: boolean };
  replica: { host: string; ssl: boolean };
  using_replica: boolean;
} {
  const primaryUrl = getPrimaryDatabaseUrl();
  const replicaUrl = getReplicaDatabaseUrl();

  return {
    primary: {
      host: parseDbHost(primaryUrl),
      ssl: isSupabaseUrl(primaryUrl) || primaryUrl.includes('sslmode=require')
    },
    replica: {
      host: parseDbHost(replicaUrl),
      ssl: isSupabaseUrl(replicaUrl) || replicaUrl.includes('sslmode=require')
    },
    using_replica: primaryUrl !== replicaUrl
  };
}
