/**
 * Integration Test Setup
 *
 * Shared setup/teardown for integration tests.
 * Use with vitest's globalSetup/globalTeardown or beforeAll/afterAll.
 */

import { Pool } from 'pg';
import {
  isDatabaseAvailable,
  createIntegrationPool,
  ensureDatabase,
  resetDatabase,
  teardownDatabase
} from './db-harness';

let pool: Pool | null = null;
let dbAvailable = false;

/**
 * Check if integration tests can run
 */
export async function canRunIntegrationTests(): Promise<boolean> {
  if (dbAvailable) return true;
  dbAvailable = await isDatabaseAvailable();
  return dbAvailable;
}

/**
 * Get or create the shared pool for integration tests
 */
export async function getIntegrationPool(): Promise<Pool> {
  if (!pool) {
    pool = createIntegrationPool();
    await ensureDatabase(pool);
  }
  return pool;
}

/**
 * Reset database state between test suites
 */
export async function resetIntegrationState(): Promise<void> {
  if (pool) {
    await resetDatabase(pool);
    await ensureDatabase(pool);
  }
}

/**
 * Cleanup after all integration tests
 */
export async function cleanupIntegration(): Promise<void> {
  if (pool) {
    await teardownDatabase(pool);
    pool = null;
  }
  dbAvailable = false;
}

/**
 * Vitest global setup hook
 */
export async function setup(): Promise<void> {
  const available = await canRunIntegrationTests();
  if (available) {
    console.log('Integration test database available, setting up...');
    await getIntegrationPool();
    console.log('Integration test database ready');
  } else {
    console.log('Integration test database not available, skipping setup');
  }
}

/**
 * Vitest global teardown hook
 */
export async function teardown(): Promise<void> {
  await cleanupIntegration();
}
