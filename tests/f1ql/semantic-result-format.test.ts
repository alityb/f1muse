import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatAnswerRows } from '../../src/f1ql/answer-format';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';
import { PLANNED_INTEGRITY_FIELD } from '../../src/f1ql/planned-compiler';
import {
  planSemanticAnswerFromResolution,
  SemanticDriverMention
} from '../../src/f1ql/semantic-planner';
import {
  collectSemanticResolutionEvidence
} from '../../src/f1ql/semantic-resolution-evidence';
import { proveSemanticAnswerPlan } from '../../src/f1ql/semantic-plan-proof';
import {
  formatSemanticPlanResult,
  SemanticResultFormatError
} from '../../src/f1ql/semantic-result-format';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticEvidence,
  SemanticLiteralSpan
} from '../../src/f1ql/semantic-query';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const EVENT_DATE = 'List event name and race date from round 1 of final 2025 event metadata.';

describe('generic proven semantic result formatting', () => {
  it('derives standings presentation and metadata from the proof and remains a family-formatter oracle', async () => {
    const { proof } = await prepare(STANDINGS);
    const rows = [
      { driver_id: 'charles-leclerc', points: null, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const formatted = formatSemanticPlanResult(proof, rows);

    expect(formatted.answer).toEqual({
      headline: 'Final 2025 driver standings result.',
      facts: [
        { subject: 'charles-leclerc', values: { points: null } },
        { subject: 'lando-norris', values: { points: '357' } }
      ]
    });
    expect(formatted.metadata.columns).toMatchObject([
      { id: 'driver_id', label: 'driver', kind: 'dimension', units: null },
      { id: 'points', label: 'championship points', kind: 'measure', units: 'points' }
    ]);
    expect(formatted.metadata.scope).toEqual([{
      source_id: 'driver_standings', concept_id: 'season', label: 'season', operator: 'eq', values: [2025]
    }]);
    expect(formatted.metadata.sources[0]).toMatchObject({
      id: 'driver_standings', label: 'driver standings',
      coverage: { freshness_class: 'mixed_final_and_latest', observed_seasons: { as_of: '2026-07-22' } }
    });
    expect(formatted.metadata.sources[0].authority.primary).toContain('season_driver_standing');
    expect(formatted.metadata.caveats).toContain('Do not derive championship points or rank from race classification points.');
    expect(formatted.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 2, row_limit: 100 });
    expect(formatted.rows[1].points).toBe('357.000');
    expect(Object.keys(formatted.rows[1])).toEqual(['driver_id', 'points']);
    expect(Object.isFrozen(formatted)).toBe(true);
    expect(Object.isFrozen(formatted.metadata.columns)).toBe(true);

    const legacyProgram: F1QLProgram = {
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
        group_by: ['driver_id'],
        measures: [{ as: 'points', function: 'max', field: 'points' }]
      }
    };
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('legacy oracle fixture was not authorized');
    const legacy = formatAnswerRows(legacyProgram, decision.capability, rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row));
    expect({ answer: formatted.answer, coverage: formatted.metadata.coverage.status })
      .toEqual({ answer: legacy.answer, coverage: legacy.coverage });
  });

  it('formats a complete metadata join without erasing nullable positions', async () => {
    const { proof } = await prepare(RACE_METADATA, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = formatSemanticPlanResult(proof, [
      {
        driver_id: 'lando-norris', finishing_position: 1,
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      },
      {
        driver_id: 'oscar-piastri', finishing_position: null,
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      }
    ]);

    expect(formatted.answer.facts).toEqual([
      {
        subject: 'lando-norris',
        values: { finishing_position: '1', event_name: 'Australian Grand Prix', circuit_id: 'albert-park' }
      },
      {
        subject: 'oscar-piastri',
        values: { finishing_position: null, event_name: 'Australian Grand Prix', circuit_id: 'albert-park' }
      }
    ]);
    expect(formatted.metadata.sources.map(source => source.id)).toEqual(['event_classification', 'event_metadata']);
    expect(formatted.metadata.scope).toMatchObject([
      { source_id: 'event_classification', concept_id: 'round', values: [1] },
      { source_id: 'event_classification', concept_id: 'season', values: [2025] },
      { source_id: 'event_metadata', concept_id: 'round', values: [1] },
      { source_id: 'event_metadata', concept_id: 'season', values: [2025] }
    ]);
    expect(formatted.metadata.ordering).toEqual([{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]);
  });

  it('states aggregate locality semantics and accepts factual zero only with proven integrity', async () => {
    const norris = span(COMPOSE, 'Norris');
    const mention: SemanticDriverMention = {
      ...norris,
      candidates: ['lando-norris'],
      active_candidates: ['lando-norris']
    };
    const { proof } = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [mention]);
    const formatted = formatSemanticPlanResult(proof, [{
      event_classification__count_finishing_position: 0,
      qualifying_classification__count_qualifying_position: 2,
      [PLANNED_INTEGRITY_FIELD]: true
    }]);

    expect(formatted.answer.facts).toEqual([{
      subject: 'result 1',
      values: {
        event_classification__count_finishing_position: '0',
        qualifying_classification__count_qualifying_position: '2'
      }
    }]);
    expect(formatted.metadata.columns).toMatchObject([
      { label: 'count of finishing position', aggregation: 'count', units: 'count', nullable: false },
      { label: 'count of qualifying position', aggregation: 'count', units: 'count', nullable: false }
    ]);
    expect(formatted.metadata.aggregations.map(item => item.semantics)).toEqual([
      'Count of non-null finishing position values after all source-specific predicates.',
      'Count of non-null qualifying position values after all source-specific predicates.'
    ]);
    expect(formatted.metadata.scope.filter(item => item.concept_id === 'driver_id'))
      .toEqual([
        { source_id: 'event_classification', concept_id: 'driver_id', label: 'driver', operator: 'eq', values: ['lando-norris'] },
        { source_id: 'qualifying_classification', concept_id: 'driver_id', label: 'driver', operator: 'eq', values: ['lando-norris'] }
      ]);
  });

  it('distinguishes an empty row result from a scalar zero', async () => {
    const standings = await prepare(STANDINGS);
    const empty = formatSemanticPlanResult(standings.proof, []);
    expect(empty.answer).toEqual({ headline: 'No matching source rows were available.', facts: [] });
    expect(empty.metadata.coverage).toEqual({ status: 'empty', rows_returned: 0, row_limit: 100 });
    expect(empty.metadata.caveats[0]).toBe('Empty output is unavailable data, not a factual zero.');

    const norris = span(COMPOSE, 'Norris');
    const composed = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [{
      ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    expect(() => formatSemanticPlanResult(composed.proof, [])).toThrow('exactly one row');
  });

  it('rejects copied proofs and malformed, partial, unexpected, or integrity-failed rows', async () => {
    const { proof } = await prepare(STANDINGS);
    const valid = { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true };
    expect(() => formatSemanticPlanResult({ ...proof }, [valid])).toThrow('provenance');
    expect(() => formatSemanticPlanResult(proof, null)).toThrow(SemanticResultFormatError);
    for (const [name, row] of [
      ['missing field', { points: '357.000', [PLANNED_INTEGRITY_FIELD]: true }],
      ['extra field', { ...valid, extra: true }],
      ['false integrity', { ...valid, [PLANNED_INTEGRITY_FIELD]: false }],
      ['numeric number', { ...valid, points: 357 }],
      ['invalid decimal', { ...valid, points: 'not-a-decimal' }],
      ['empty identity', { ...valid, driver_id: '' }],
      ['blank identity', { ...valid, driver_id: '   ' }],
      ['malformed unicode', { ...valid, driver_id: '\ud800' }],
      ['accessor', Object.defineProperty({ ...valid }, 'points', { enumerable: true, get: () => '357.000' })],
      ['prototype', Object.assign(Object.create({ inherited: true }), valid)],
      ['symbol', Object.assign({ ...valid }, { [Symbol('unexpected')]: true })]
    ] as const) {
      let failure: unknown;
      try {formatSemanticPlanResult(proof, [row]);} catch (error) {failure = error;}
      expect(failure, name).toBeInstanceOf(SemanticResultFormatError);
    }
  });

  it('rejects sparse arrays and snapshots descriptor values before validation', async () => {
    const { proof } = await prepare(STANDINGS);
    const sparse = new Array(1);
    expect(() => formatSemanticPlanResult(proof, sparse)).toThrow('dense array');

    const target = { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true };
    const proxy = new Proxy(target, {
      get: (_target, property) => property === 'points' ? 'substituted' : Reflect.get(target, property)
    });
    const formatted = formatSemanticPlanResult(proof, [proxy]);
    expect(formatted.answer.facts[0].values.points).toBe('357');
    expect(formatted.rows[0].points).toBe('357.000');

    const overriddenMap = [target];
    Object.defineProperty(overriddenMap, 'map', {
      value: () => [{ driver_id: 'substituted', points: 357 }]
    });
    expect(formatSemanticPlanResult(proof, overriddenMap).answer.facts[0].subject).toBe('lando-norris');
  });

  it('rejects duplicate, tied, misordered, and over-limit row results', async () => {
    const { proof } = await prepare(STANDINGS);
    const row = (driver_id: string) => ({ driver_id, points: '1.000', [PLANNED_INTEGRITY_FIELD]: true });
    expect(() => formatSemanticPlanResult(proof, [row('a'), row('a')])).toThrow('duplicate output grain');
    expect(() => formatSemanticPlanResult(proof, [row('b'), row('a')])).toThrow('ordering');
    const overLimit = Array.from({ length: 101 }, (_, index) => row(`driver-${String(index).padStart(3, '0')}`));
    expect(() => formatSemanticPlanResult(proof, overLimit)).toThrow('row limit');
    let accessed = false;
    const rejectedBeforeAccess = new Array(101);
    Object.defineProperty(rejectedBeforeAccess, 0, { get: () => {accessed = true; return row('driver-000');} });
    expect(() => formatSemanticPlanResult(proof, rejectedBeforeAccess)).toThrow('row limit');
    expect(accessed).toBe(false);

    const atLimit = formatSemanticPlanResult(proof, overLimit.slice(0, 100));
    expect(atLimit.metadata.coverage).toEqual({ status: 'possibly_truncated', rows_returned: 100, row_limit: 100 });
    expect(atLimit.metadata.caveats[0]).toBe('Output reached the proven 100-row limit.');
  });

  it('independently rejects invalid positions and incomplete joined metadata', async () => {
    const { proof } = await prepare(RACE_METADATA, [], [], { type: 'resolved', season: 2025, round: 1 });
    const valid = {
      driver_id: 'lando-norris', finishing_position: 1,
      event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
      [PLANNED_INTEGRITY_FIELD]: true
    };
    for (const mutation of [
      { finishing_position: 31 },
      { event_name: null },
      { event_name: '   ' },
      { circuit_id: null }
    ]) {
      expect(() => formatSemanticPlanResult(proof, [{ ...valid, ...mutation }])).toThrow(SemanticResultFormatError);
    }
  });

  it('rejects negative aggregate counts', async () => {
    const norris = span(COMPOSE, 'Norris');
    const { proof } = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [{
      ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    expect(() => formatSemanticPlanResult(proof, [{
      event_classification__count_finishing_position: -1,
      qualifying_classification__count_qualifying_position: 2,
      [PLANNED_INTEGRITY_FIELD]: true
    }])).toThrow('nonnegative count');
  });

  it('normalizes PostgreSQL-style local-midnight dates without UTC date drift', async () => {
    const { proof } = await prepare(EVENT_DATE, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = formatSemanticPlanResult(proof, [{
      event_name: 'Australian Grand Prix', date: new Date(2025, 0, 1), [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatted.rows[0].date).toBe('2025-01-01');
    expect(() => formatSemanticPlanResult(proof, [{
      event_name: 'Australian Grand Prix', date: new Date(2025, 0, 1, 12), [PLANNED_INTEGRITY_FIELD]: true
    }])).toThrow('date-only');
  });

  it('has no route, database, provider, or execution dependency', () => {
    const source = readFileSync('src/f1ql/semantic-result-format.ts', 'utf8');
    expect(source).not.toMatch(/from ['"](?:pg|\.\/executor|\.\.\/api|\.\/answer-execution)/u);
    expect(source).not.toMatch(/executeF1QL|database\.query|pool\.query/u);
  });
});

async function prepare(
  question: string,
  entities: readonly unknown[] = [],
  mentions: readonly SemanticDriverMention[] = [],
  eventResolution: { readonly type: 'resolved'; readonly season: number; readonly round: number } |
    { readonly type: 'ambiguous'; readonly candidates: readonly { readonly season: number; readonly round: number }[] } |
    { readonly type: 'missing' } = { type: 'missing' }
) {
  const evidence = enumerateSemanticQueries(question, entities);
  expect(evidence.type).toBe('candidate_set');
  const candidates = (evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>).candidates;
  const admission = admitSemanticQueryCandidates({ version: 2, candidates }, question, evidence);
  if (admission.type !== 'admitted') throw new Error('test semantic query was not admitted');
  const resolution = await collectSemanticResolutionEvidence({
    question,
    admission,
    driver_resolver: { inventoryMentions: async () => mentions },
    event_resolver: {
      resolve: async () => eventResolution,
      resolveRound: async () => eventResolution
    }
  });
  const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
  const proof = proveSemanticAnswerPlan({ question, entity_inventory: entities, evidence, admission, resolution, plan });
  return { proof, plan };
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}
