import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';
import { emitAnswerEvaluationResults } from '../../scripts/snapshot-answer-evaluation-results';
import { F1QLLinkingError, linkAnswerF1QLCandidateObserved } from '../../src/f1ql/translation-linking';
import { seedAnswerEvaluationFixture } from '../fixtures/f1ql-answer-evaluation-fixture';

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: getTestDatabaseUrl() });
  await setupTestDatabase(pool, { seed: false });
  await seedAnswerEvaluationFixture(pool);
  await pool.query(readFileSync('migrations/20260729_f1ql_answer_identity_views.sql', 'utf8'));
});

afterAll(async () => {
  await pool.query('DROP VIEW IF EXISTS f1ql.answer_event_identity, f1ql.answer_driver_identity, f1ql.answer_season_participation');
  await pool.query('DROP TABLE IF EXISTS driver_aliases');
  await pool.end();
});

describe('answer evaluation generated results', () => {
  it('matches the real bounded canonical-program emitter', async () => {
    const expected = JSON.parse(readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8'));
    await expect(emitAnswerEvaluationResults(pool)).resolves.toEqual(expected);
  });

  it('observes resolver candidates and the reviewed ambiguous event', async () => {
    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, event_name: 'Ambiguous Grand Prix', limit: 30 }
    })).rejects.toMatchObject<F1QLLinkingError>({
      code: 'event_ambiguous',
      entityCandidates: ['event:2025:8', 'event:2025:9']
    });

    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, event_name: 'Australian Grand Prix', limit: 30, filters: { driver_id: 'Max Verstappen' } }
    })).resolves.toMatchObject({
      entityCandidates: ['driver:max-verstappen', 'event:2025:1']
    });

    await expect(linkAnswerF1QLCandidateObserved(pool, {
      version: 1,
      root: { op: 'event_classification', season: 2025, round: 1, limit: 30, filters: { driver_id: 'Alex Smith' } }
    })).rejects.toMatchObject<F1QLLinkingError>({
      code: 'entity_ambiguous',
      entityCandidates: ['driver:alex-one', 'driver:alex-two', 'event:2025:1']
    });
  });
});
