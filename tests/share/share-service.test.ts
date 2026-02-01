import { describe, it, expect, beforeAll } from 'vitest';
import {
  ShareService,
  SCHEMA_VERSION,
  truncateWithEllipsis,
  formatHeadline,
  formatSummary,
  FEED_ORDER
} from '../../src/share/share-service';
import { Pool } from 'pg';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let pool: Pool | null = null;
let dbAvailable = false;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) {
    console.log('TEST_DATABASE_URL not set, skipping share service tests');
    return;
  }

  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query('SELECT 1');
    dbAvailable = true;

    const service = new ShareService(pool);
    await service.ensureTable();
  } catch {
    console.log('Test database not available, skipping share service tests');
    dbAvailable = false;
  }
});

describe('ShareService', () => {
  it.skipIf(!dbAvailable)('should create a share with short id', async () => {
    const service = new ShareService(pool!);

    const share = await service.create({
      query_kind: 'teammate_gap_summary_season',
      params: { driver_a_id: 'norris', driver_b_id: 'piastri', season: 2025 },
      season: 2025,
      answer: {
        query_kind: 'teammate_gap_summary_season',
        headline: 'Norris was 0.15% faster than Piastri in 2025',
        bullets: ['Gap: +0.15% (Norris faster)', 'Based on 18 shared races'],
        coverage: { level: 'high', summary: '18 races analyzed' }
      },
      headline: 'Norris was 0.15% faster than Piastri in 2025'
    });

    expect(share.id).toHaveLength(8);
    expect(share.query_kind).toBe('teammate_gap_summary_season');
    expect(share.season).toBe(2025);
    expect(share.headline).toBe('Norris was 0.15% faster than Piastri in 2025');
    expect(share.view_count).toBe(0);
    expect(share.created_at).toBeInstanceOf(Date);
  });

  it.skipIf(!dbAvailable)('should lookup existing share', async () => {
    const service = new ShareService(pool!);

    const created = await service.create({
      query_kind: 'driver_season_summary',
      params: { driver_id: 'verstappen', season: 2024 },
      season: 2024,
      answer: { headline: 'Verstappen 2024: 19 wins', bullets: ['19 wins'] },
      headline: 'Verstappen 2024: 19 wins'
    });

    const result = await service.lookup(created.id);

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.expired).toBe(false);
      expect(result.share.id).toBe(created.id);
      expect(result.share.query_kind).toBe('driver_season_summary');
    }
  });

  it.skipIf(!dbAvailable)('should return not found for invalid id', async () => {
    const service = new ShareService(pool!);

    const result = await service.lookup('notexist');

    expect(result.found).toBe(false);
  });

  it.skipIf(!dbAvailable)('should detect expired shares', async () => {
    const service = new ShareService(pool!);

    const pastDate = new Date(Date.now() - 86400000); // 1 day ago
    const created = await service.create({
      query_kind: 'race_results_summary',
      params: { track_id: 'monza', season: 2024 },
      season: 2024,
      answer: { headline: 'Monza 2024 Results' },
      headline: 'Monza 2024 Results',
      expires_at: pastDate
    });

    const result = await service.lookup(created.id);

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.expired).toBe(true);
    }
  });

  it.skipIf(!dbAvailable)('should increment view count', async () => {
    const service = new ShareService(pool!);

    const created = await service.create({
      query_kind: 'track_fastest_drivers',
      params: { track_id: 'silverstone', season: 2025 },
      season: 2025,
      answer: { headline: 'Silverstone fastest drivers' },
      headline: 'Silverstone fastest drivers'
    });

    await service.incrementViewCount(created.id);
    await service.incrementViewCount(created.id);

    const result = await service.lookup(created.id);
    expect(result.found).toBe(true);
    if (result.found && !result.expired) {
      expect(result.share.view_count).toBe(2);
    }
  });
});

describe('Share ID format', () => {
  it('should generate 8-character alphanumeric ids', async () => {
    if (!dbAvailable || !pool) {
      return;
    }

    const service = new ShareService(pool);
    const ids = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const share = await service.create({
        query_kind: 'driver_season_summary',
        params: { driver_id: 'test', season: 2025 },
        season: 2025,
        answer: { headline: `Test ${i}` },
        headline: `Test ${i}`
      });

      expect(share.id).toMatch(/^[a-z0-9_-]{8}$/i);
      expect(ids.has(share.id)).toBe(false);
      ids.add(share.id);
    }
  });
});

describe('Schema version', () => {
  it('should export current schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it.skipIf(!dbAvailable)('should store schema version with share', async () => {
    const service = new ShareService(pool!);

    const share = await service.create({
      query_kind: 'driver_season_summary',
      params: { driver_id: 'hamilton', season: 2024 },
      season: 2024,
      answer: { headline: 'Hamilton 2024' },
      headline: 'Hamilton 2024'
    });

    expect(share.version).toBe(SCHEMA_VERSION);
  });
});

describe('Text truncation utilities', () => {
  it('should return empty string for null/undefined', () => {
    expect(truncateWithEllipsis('', 10)).toBe('');
    expect(truncateWithEllipsis(null as any, 10)).toBe('');
  });

  it('should not truncate short text', () => {
    expect(truncateWithEllipsis('Hello', 10)).toBe('Hello');
    expect(truncateWithEllipsis('Exactly 10', 10)).toBe('Exactly 10');
  });

  it('should truncate long text with ellipsis', () => {
    expect(truncateWithEllipsis('This is a very long headline', 15)).toBe('This is a very…');
  });

  it('should trim trailing whitespace before ellipsis', () => {
    expect(truncateWithEllipsis('Hello world foo', 13)).toBe('Hello world…');
  });

  it('should format headline to max 70 chars', () => {
    const longHeadline = 'A'.repeat(100);
    const result = formatHeadline(longHeadline);
    expect(result.length).toBe(70);
    expect(result.endsWith('…')).toBe(true);
  });

  it('should format summary to max 160 chars', () => {
    const longSummary = 'B'.repeat(200);
    const result = formatSummary(longSummary);
    expect(result.length).toBe(160);
    expect(result.endsWith('…')).toBe(true);
  });

  it('should handle null summary', () => {
    expect(formatSummary(null)).toBe('');
  });
});

describe('Feed order config', () => {
  it('should default to trending', () => {
    expect(FEED_ORDER).toBe('trending');
  });
});
