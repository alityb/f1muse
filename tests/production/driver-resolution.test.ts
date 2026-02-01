import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriverResolver } from '../../src/identity/driver-resolver';
import { Pool } from 'pg';

/**
 * Driver Resolution Tests
 *
 * Tests for production driver name resolution including:
 * - Full names ("Max Verstappen")
 * - Last names only ("Verstappen")
 * - Case-insensitive input ("max verstappen", "MAX")
 * - Diacritics handling ("Pérez" → "perez")
 * - Underscores/hyphens ("max_verstappen", "max-verstappen")
 * - Abbreviations ("VER")
 */

// Simulated driver rows from database
const mockDriverRows = [
  { id: 'max_verstappen', full_name: 'Max Verstappen', first_name: 'Max', last_name: 'Verstappen', abbreviation: 'VER' },
  { id: 'sergio_perez', full_name: 'Sergio Pérez', first_name: 'Sergio', last_name: 'Pérez', abbreviation: 'PER' },
  { id: 'lewis_hamilton', full_name: 'Lewis Hamilton', first_name: 'Lewis', last_name: 'Hamilton', abbreviation: 'HAM' },
  { id: 'lando_norris', full_name: 'Lando Norris', first_name: 'Lando', last_name: 'Norris', abbreviation: 'NOR' },
  { id: 'charles_leclerc', full_name: 'Charles Leclerc', first_name: 'Charles', last_name: 'Leclerc', abbreviation: 'LEC' },
  { id: 'carlos_sainz', full_name: 'Carlos Sainz', first_name: 'Carlos', last_name: 'Sainz', abbreviation: 'SAI' },
];

// Create mock pool
function createMockPool(): Pool {
  const mockPool = {
    query: vi.fn().mockImplementation((query: string) => {
      if (query.includes('FROM driver')) {
        return Promise.resolve({ rows: mockDriverRows });
      }
      if (query.includes('season_entrant_driver')) {
        return Promise.resolve({ rows: [] });
      }
      if (query.includes('driver_season_entries')) {
        return Promise.resolve({ rows: [] });
      }
      if (query.includes('pace_metric_summary')) {
        return Promise.resolve({ rows: [] });
      }
      if (query.includes('laps_normalized')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
  return mockPool;
}

describe('DriverResolver', () => {
  let resolver: DriverResolver;
  let mockPool: Pool;

  beforeEach(() => {
    mockPool = createMockPool();
    resolver = new DriverResolver(mockPool);
  });

  describe('Full name resolution', () => {
    it('should resolve "Max Verstappen" to max_verstappen', async () => {
      const result = await resolver.resolve('Max Verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "Sergio Pérez" with diacritics to sergio_perez', async () => {
      const result = await resolver.resolve('Sergio Pérez');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('sergio_perez');
    });

    it('should resolve "Lewis Hamilton" to lewis_hamilton', async () => {
      const result = await resolver.resolve('Lewis Hamilton');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('lewis_hamilton');
    });
  });

  describe('Last name only resolution', () => {
    it('should resolve "Verstappen" to max_verstappen', async () => {
      const result = await resolver.resolve('Verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "Hamilton" to lewis_hamilton', async () => {
      const result = await resolver.resolve('Hamilton');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('lewis_hamilton');
    });

    it('should resolve "Pérez" with diacritics to sergio_perez', async () => {
      const result = await resolver.resolve('Pérez');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('sergio_perez');
    });

    it('should resolve "Perez" without diacritics to sergio_perez', async () => {
      const result = await resolver.resolve('Perez');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('sergio_perez');
    });
  });

  describe('Case-insensitive resolution', () => {
    it('should resolve "max verstappen" (lowercase) to max_verstappen', async () => {
      const result = await resolver.resolve('max verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "MAX VERSTAPPEN" (uppercase) to max_verstappen', async () => {
      const result = await resolver.resolve('MAX VERSTAPPEN');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "mAx VeRsTaPpEn" (mixed case) to max_verstappen', async () => {
      const result = await resolver.resolve('mAx VeRsTaPpEn');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });
  });

  describe('ID format resolution', () => {
    it('should resolve "max_verstappen" (underscore format) to max_verstappen', async () => {
      const result = await resolver.resolve('max_verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "max-verstappen" (hyphen format) to max_verstappen', async () => {
      const result = await resolver.resolve('max-verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "sergio_perez" to sergio_perez', async () => {
      const result = await resolver.resolve('sergio_perez');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('sergio_perez');
    });
  });

  describe('Abbreviation resolution', () => {
    it('should resolve "VER" to max_verstappen', async () => {
      const result = await resolver.resolve('VER');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "ver" (lowercase) to max_verstappen', async () => {
      const result = await resolver.resolve('ver');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "HAM" to lewis_hamilton', async () => {
      const result = await resolver.resolve('HAM');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('lewis_hamilton');
    });

    it('should resolve "PER" to sergio_perez', async () => {
      const result = await resolver.resolve('PER');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('sergio_perez');
    });
  });

  describe('First name resolution', () => {
    it('should resolve "Max" to max_verstappen', async () => {
      const result = await resolver.resolve('Max');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "Lewis" to lewis_hamilton', async () => {
      const result = await resolver.resolve('Lewis');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('lewis_hamilton');
    });
  });

  describe('Whitespace handling', () => {
    it('should resolve "  Max   Verstappen  " with extra whitespace', async () => {
      const result = await resolver.resolve('  Max   Verstappen  ');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });

    it('should resolve "max    verstappen" with multiple spaces', async () => {
      const result = await resolver.resolve('max    verstappen');
      expect(result.success).toBe(true);
      expect(result.f1db_driver_id).toBe('max_verstappen');
    });
  });

  describe('Unknown driver handling', () => {
    it('should return error for unknown driver "John Smith"', async () => {
      const result = await resolver.resolve('John Smith');
      expect(result.success).toBe(false);
      expect(result.error).toBe('unknown_driver');
    });

    it('should return error for empty string', async () => {
      const result = await resolver.resolve('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('unknown_driver');
    });

    it('should return error for whitespace only', async () => {
      const result = await resolver.resolve('   ');
      expect(result.success).toBe(false);
      expect(result.error).toBe('unknown_driver');
    });
  });
});
