import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { FEED_ORDER, formatHeadline, formatSummary, SCHEMA_VERSION, ShareService, truncateWithEllipsis } from '../../src/share/share-service';

describe('immutable share retrieval and feed', () => {
  it('returns a stored answer without recomputation', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      id: 'stored01', version: 1, query_kind: 'race_result_selection', params: { season: 2025 },
      season: 2025, answer: { facts: ['stored'] }, headline: 'Stored result', summary: 'Immutable',
      created_at: '2025-01-01T00:00:00.000Z', expires_at: null, view_count: 4
    }] });
    const result = await new ShareService({ query } as unknown as Pool).lookup('stored01');

    expect(query).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ found: true, expired: false, share: { answer: { facts: ['stored'] } } });
    expect(String(query.mock.calls[0][0])).toContain('SELECT * FROM shared_queries WHERE id = $1');
  });

  it('returns not found and detects expiration', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'expired1', version: 1, query_kind: 'race_result_selection', params: {}, season: 2025,
        answer: {}, headline: 'Expired', summary: null, created_at: new Date(),
        expires_at: '2000-01-01T00:00:00.000Z', view_count: 0
      }] });
    const service = new ShareService({ query } as unknown as Pool);

    await expect(service.lookup('missing1')).resolves.toEqual({ found: false });
    await expect(service.lookup('expired1')).resolves.toMatchObject({ found: true, expired: true });
  });

  it('serves bounded recent and trending feed projections', async () => {
    const rows = [{ id: 'stored01', headline: 'Stored result', summary: 'Immutable', created_at: '2025-01-01T00:00:00.000Z', view_count: 4 }];
    const query = vi.fn().mockResolvedValue({ rows });
    const feed = await new ShareService({ query } as unknown as Pool).getFeed();

    expect(feed.recent).toEqual(feed.trending);
    expect(feed.recent[0]).toMatchObject({ id: 'stored01', created_at: '2025-01-01T00:00:00.000Z' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('share rendering metadata', () => {
  it('retains the historical schema version and feed order', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(FEED_ORDER).toBe('trending');
  });

  it('bounds headline and summary text', () => {
    expect(truncateWithEllipsis('Hello', 10)).toBe('Hello');
    expect(formatHeadline('A'.repeat(100))).toHaveLength(70);
    expect(formatSummary('B'.repeat(200))).toHaveLength(160);
    expect(formatSummary(null)).toBe('');
  });
});
