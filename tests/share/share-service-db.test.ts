import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { ShareService } from '../../src/share/share-service';

const ids = ['f1ql001a', 'f1ql001b'];
let pool: Pool;
let service: ShareService;

beforeAll(async () => {
  if (process.env.REQUIRE_TEST_DATABASE !== 'true') {
    throw new Error('share-service-db.test.ts must run through a wrapped database script');
  }
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query(readFileSync('migrations/007_shared_queries.sql', 'utf8'));
  await pool.query('DELETE FROM shared_queries WHERE id = ANY($1::text[])', [ids]);
  await pool.query(
    `INSERT INTO shared_queries
      (id, version, query_kind, params, season, answer, headline, summary, created_at, expires_at, view_count)
     VALUES
      ($1, 1, 'race_result_selection', $3::jsonb, 2025, $4::jsonb, 'Stored result', 'Immutable', NOW(), NULL, 4),
      ($2, 1, 'race_result_selection', '{}'::jsonb, 2025, '{}'::jsonb, 'Expired result', NULL, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day', 0)`,
    [ids[0], ids[1], JSON.stringify({ season: 2025 }), JSON.stringify({ facts: ['stored'] })]
  );
  service = new ShareService(pool);
});

afterAll(async () => {
  await pool.query('DELETE FROM shared_queries WHERE id = ANY($1::text[])', [ids]);
  await pool.end();
});

describe('immutable share PostgreSQL contract', () => {
  it('decodes stored JSON and timestamps without recomputation', async () => {
    await expect(service.lookup(ids[0])).resolves.toMatchObject({
      found: true,
      expired: false,
      share: {
        id: ids[0],
        params: { season: 2025 },
        answer: { facts: ['stored'] },
        created_at: expect.any(Date),
        expires_at: null,
        view_count: 4
      }
    });
    await expect(service.lookup('missing1')).resolves.toEqual({ found: false });
    await expect(service.lookup(ids[1])).resolves.toMatchObject({ found: true, expired: true });
  });

  it('updates view counts and reads bounded feed projections', async () => {
    await service.incrementViewCount(ids[0]);
    await expect(service.lookup(ids[0])).resolves.toMatchObject({ share: { view_count: 5 } });

    const feed = await service.getFeed();
    expect(feed.recent).toContainEqual(expect.objectContaining({ id: ids[0], view_count: 5 }));
    expect(feed.trending).toContainEqual(expect.objectContaining({ id: ids[0], view_count: 5 }));
    expect(feed.recent).not.toContainEqual(expect.objectContaining({ id: ids[1] }));
  });
});
