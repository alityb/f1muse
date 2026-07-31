import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLANNED_INTEGRITY_FIELD } from '../src/f1ql/planned-compiler';
import { PLANNED_F1QL_MAX_ROWS, PLANNED_F1QL_MAX_WORK_UNITS } from '../src/f1ql/planned-f1ql';
import { preparePlannedF1QLParent } from '../src/f1ql/planned-pipeline';
import { verifyAnswerPlan } from '../src/f1ql/semantic-planner';
import { proveSemanticAnswerPlan, verifySemanticPlanProof } from '../src/f1ql/semantic-plan-proof';
import { verifySemanticResolutionEvidence } from '../src/f1ql/semantic-resolution-evidence';
import { formatSemanticPlanResult, SemanticResultFormatError } from '../src/f1ql/semantic-result-format';
import {
  computeSemanticEvidenceHash,
  verifySemanticEvidence,
  verifySemanticQueryAdmission
} from '../src/f1ql/semantic-query';
import { compositionalRegressionCorpusInput } from './fixtures/compositional-regression-corpus';
import {
  ANSWER_PLAN_MUTATION_CATEGORIES,
  NAMED_ANSWER_PLAN_MUTATIONS,
  RESULT_MUTATION_ACCOUNTING,
  RESULT_MUTATION_CATEGORIES
} from './support/compositional-mutations';
import {
  CompositionalAnswerFixtureInput,
  prepareCompositionalAnswerArtifacts,
  prepareReviewedCompositionalAnswerCase
} from './support/compositional-regression';

const DEFAULT_PROPERTY_SEED = 20260730;
const DEFAULT_PROPERTY_RUNS = 120;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const STANDINGS_CASE = 'promoted-single-source-rows';
const JOIN_CASE = 'promoted-safe-dimension-join';
const COMPOSE_CASE = 'promoted-aggregate-locality';

type Prepared = Awaited<ReturnType<typeof prepareCompositionalAnswerArtifacts>>;

describe('Phase 11 offline plan mutations', () => {
  it('prepares live artifacts from reviewed answer cases and rejects every named structural mutation', async () => {
    const preparedByCase = new Map<string, Awaited<ReturnType<typeof prepareReviewedCompositionalAnswerCase>>>();
    for (const mutation of NAMED_ANSWER_PLAN_MUTATIONS) {
      let prepared = preparedByCase.get(mutation.corpus_case_id);
      if (!prepared) {
        prepared = await prepareReviewedCompositionalAnswerCase(
          compositionalRegressionCorpusInput, mutation.corpus_case_id
        );
        preparedByCase.set(mutation.corpus_case_id, prepared);
      }
      const mutated = structuredClone(prepared.plan);
      mutation.mutate(mutated);
      expect(mutated, `${mutation.name} must change the plan`).not.toEqual(prepared.plan);
      expect(() => proveSemanticAnswerPlan({
        question: prepared.question,
        entity_inventory: prepared.entity_inventory,
        evidence: prepared.evidence,
        admission: prepared.admission,
        resolution: prepared.resolution,
        plan: mutated
      }), mutation.name).toThrowError(expect.objectContaining({ reason: 'plan_mismatch' }));
      if (mutation.planned_validation_rejects) {
        expect(() => preparePlannedF1QLParent(mutated.planned_f1ql), mutation.name).toThrow();
      } else {
        expect(() => preparePlannedF1QLParent(mutated.planned_f1ql), mutation.name).not.toThrow();
      }
    }

    await expect(prepareReviewedCompositionalAnswerCase(
      compositionalRegressionCorpusInput, 'ambiguity-metric'
    )).rejects.toThrow('reviewed compositional answer case is unavailable');
  });

  it('accounts for every required plan mutation category exactly once', () => {
    expect(NAMED_ANSWER_PLAN_MUTATIONS.map(mutation => mutation.category).sort())
      .toEqual([...ANSWER_PLAN_MUTATION_CATEGORIES].sort());
    expect(new Set(NAMED_ANSWER_PLAN_MUTATIONS.map(mutation => mutation.name)).size)
      .toBe(NAMED_ANSWER_PLAN_MUTATIONS.length);
  });
});

describe('Phase 11 offline result mutation accounting', () => {
  let standings: Prepared;
  let join: Prepared;
  let compose: Prepared;
  let filteredStandings: Prepared;

  beforeAll(async () => {
    const filteredQuestion = 'List driver, championship position, and championship points for Norris and Piastri from final 2025 driver standings.';
    [standings, join, compose, filteredStandings] = await Promise.all([
      prepareReviewedCompositionalAnswerCase(compositionalRegressionCorpusInput, STANDINGS_CASE),
      prepareReviewedCompositionalAnswerCase(compositionalRegressionCorpusInput, JOIN_CASE),
      prepareReviewedCompositionalAnswerCase(compositionalRegressionCorpusInput, COMPOSE_CASE),
      prepareCompositionalAnswerArtifacts({
        question: filteredQuestion,
        entities: [{ type: 'driver', text: 'Norris' }, { type: 'driver', text: 'Piastri' }],
        resolver: {
          driver_mentions: [
            { text: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
            { text: 'Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
          ],
          event_resolution: { type: 'missing' }
        }
      })
    ]);
  });

  it('rejects every offline-detectable result mutation', () => {
    const standingsRow = (driverId: string, points = '1.000') => ({
      driver_id: driverId, points, [PLANNED_INTEGRITY_FIELD]: true
    });
    const filteredRow = (driverId: string, position: number) => ({
      driver_id: driverId,
      championship_position: position,
      points: '1.000',
      [PLANNED_INTEGRITY_FIELD]: true
    });
    const joinRow = {
      driver_id: 'lando-norris', finishing_position: 1,
      event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
      [PLANNED_INTEGRITY_FIELD]: true
    };
    const composeRow = {
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 1,
      [PLANNED_INTEGRITY_FIELD]: true
    };
    const attempts: Record<string, () => unknown> = {
      'non-array-result': () => formatSemanticPlanResult(standings.proof, null),
      'omit-filtered-driver-row': () => formatSemanticPlanResult(filteredStandings.proof, [
        filteredRow('lando-norris', 1)
      ]),
      'repeat-identical-grain': () => formatSemanticPlanResult(standings.proof, [
        standingsRow('lando-norris'), standingsRow('lando-norris')
      ]),
      'tie-without-distinct-grain': () => formatSemanticPlanResult(standings.proof, [
        standingsRow('lando-norris', '1.000'), standingsRow('lando-norris', '2.000')
      ]),
      'reverse-proven-row-order': () => formatSemanticPlanResult(standings.proof, [
        standingsRow('oscar-piastri'), standingsRow('lando-norris')
      ]),
      'add-unproven-column': () => formatSemanticPlanResult(standings.proof, [{
        ...standingsRow('lando-norris'), injected: true
      }]),
      'replace-exact-decimal-with-number': () => formatSemanticPlanResult(standings.proof, [{
        ...standingsRow('lando-norris'), points: 1
      }]),
      'make-count-negative': () => formatSemanticPlanResult(compose.proof, [{
        ...composeRow, event_classification__count_finishing_position: -1
      }]),
      'null-required-joined-metadata': () => formatSemanticPlanResult(join.proof, [{
        ...joinRow, event_name: null
      }])
    };

    for (const mutation of RESULT_MUTATION_ACCOUNTING.filter(item => item.disposition === 'rejected_offline')) {
      let failure: unknown;
      try {attempts[mutation.name]();} catch (error) {failure = error;}
      expect(failure, mutation.name).toBeInstanceOf(SemanticResultFormatError);
    }
  });

  it('does not falsely claim rejection without runtime result provenance', () => {
    const substituted = formatSemanticPlanResult(standings.proof, [{
      driver_id: 'lando-norris', points: '999.000', [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(substituted.rows[0].points).toBe('999.000');

    const complete = [
      { driver_id: 'lando-norris', points: '1.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', points: '2.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    expect(formatSemanticPlanResult(standings.proof, complete).rows).toHaveLength(2);
    expect(formatSemanticPlanResult(standings.proof, complete.slice(0, 1)).rows).toHaveLength(1);
    expect(RESULT_MUTATION_ACCOUNTING.filter(item => item.disposition === 'blocked_without_runtime_provenance'))
      .toEqual([
        expect.objectContaining({ category: 'same-schema factual substitution' }),
        expect.objectContaining({ category: 'unfiltered row omission' })
      ]);
  });

  it('accounts for every required result category exactly once', () => {
    expect(RESULT_MUTATION_ACCOUNTING.map(mutation => mutation.category).sort())
      .toEqual([...RESULT_MUTATION_CATEGORIES].sort());
    expect(new Set(RESULT_MUTATION_ACCOUNTING.map(mutation => mutation.name)).size)
      .toBe(RESULT_MUTATION_ACCOUNTING.length);
  });
});

describe('Phase 11 bounded offline compositional properties', () => {
  it('generates deterministic reviewed variants within all planner bounds', async () => {
    await fc.assert(fc.asyncProperty(
      reviewedAnswerFixtureArbitrary,
      async fixture => {
        const first = await prepareCompositionalAnswerArtifacts(fixture);
        const repeated = await prepareCompositionalAnswerArtifacts(fixture);

        expect(first.evidence.question_sha256).toBe(sha256(fixture.question));
        expect(first.evidence.question_sha256).toBe(repeated.evidence.question_sha256);
        expect(computeSemanticEvidenceHash(first.evidence)).toBe(computeSemanticEvidenceHash(repeated.evidence));
        expect(first.resolution.resolution_hash).toBe(repeated.resolution.resolution_hash);
        expect(first.plan.answer_plan_hash).toBe(repeated.plan.answer_plan_hash);
        expect(first.plan.planned_f1ql_hash).toBe(repeated.plan.planned_f1ql_hash);
        expect(first.plan.core_hash).toBe(repeated.plan.core_hash);
        expect(first.proof.proof_hash).toBe(repeated.proof.proof_hash);
        for (const hash of [
          first.evidence.question_sha256,
          computeSemanticEvidenceHash(first.evidence),
          first.resolution.resolution_hash,
          first.plan.answer_plan_hash,
          first.plan.planned_f1ql_hash,
          first.plan.core_hash,
          first.proof.proof_hash
        ]) {
          expect(hash).toMatch(HASH_PATTERN);
        }
        expect(first.plan.work.source_scan_units).toBeLessThanOrEqual(PLANNED_F1QL_MAX_WORK_UNITS);
        expect(first.plan.work.requested_rows).toBeLessThanOrEqual(PLANNED_F1QL_MAX_ROWS);
        expect(first.plan.planned_f1ql.root.count).toBeLessThanOrEqual(PLANNED_F1QL_MAX_ROWS);

        expect(() => verifySemanticEvidence(
          structuredClone(first.evidence), first.question, first.entity_inventory
        )).toThrow('provenance');
        expect(() => verifySemanticQueryAdmission(
          structuredClone(first.admission), first.question
        )).toThrow('provenance');
        expect(() => verifySemanticResolutionEvidence(
          structuredClone(first.resolution), first.question, first.admission
        )).toThrow('provenance');
        expect(() => verifyAnswerPlan(structuredClone(first.plan))).toThrow('provenance');
        expect(() => verifySemanticPlanProof(structuredClone(first.proof))).toThrow('provenance');

      }
    ), propertyParameters());
  });
});

const yearArbitrary = fc.integer({ min: 2020, max: 2025 });
const roundArbitrary = fc.integer({ min: 1, max: 30 });
const noResolvers = {
  driver_mentions: [],
  event_resolution: { type: 'missing' as const }
};

const standingsFixtureArbitrary = fc.record({ year: yearArbitrary, alternate: fc.boolean() })
  .map(({ year, alternate }): CompositionalAnswerFixtureInput => ({
    question: alternate
      ? `Give driver and championship points from ${year} final driver standings.`
      : `List driver and championship points from final ${year} driver standings.`,
    entities: [], resolver: noResolvers
  }));

const joinFixtureArbitrary = fc.record({ year: yearArbitrary, round: roundArbitrary, alternate: fc.boolean() })
  .map(({ year, round, alternate }): CompositionalAnswerFixtureInput => ({
    question: `${alternate ? 'Give' : 'List'} driver and finishing position, event name, and circuit identifier for round ${round} of final ${year} race classification and event metadata.`,
    entities: [],
    resolver: {
      driver_mentions: [],
      event_resolution: { type: 'resolved', season: year, round }
    }
  }));

const driverArbitrary = fc.constantFrom(
  { text: 'Norris', id: 'lando-norris', historical: 'historical-norris' },
  { text: 'Piastri', id: 'oscar-piastri', historical: 'historical-piastri' }
);

const composeFixtureArbitrary = fc.record({
  year: yearArbitrary,
  driver: driverArbitrary,
  alternate: fc.boolean(),
  retainHistoricalCandidate: fc.boolean()
}).map(({ year, driver, alternate, retainHistoricalCandidate }): CompositionalAnswerFixtureInput => ({
  question: alternate
    ? `In final ${year}, show count of finishing position from race classification and count of qualifying position from qualifying classification for ${driver.text}.`
    : `Show count of finishing position from race classification and count of qualifying position from qualifying classification for ${driver.text} in final ${year}.`,
  entities: [{ type: 'driver', text: driver.text }],
  resolver: {
    driver_mentions: [{
      text: driver.text,
      candidates: retainHistoricalCandidate ? [driver.historical, driver.id].sort() : [driver.id],
      active_candidates: [driver.id]
    }],
    event_resolution: { type: 'missing' }
  }
}));

const reviewedAnswerFixtureArbitrary = fc.oneof(
  standingsFixtureArbitrary,
  joinFixtureArbitrary,
  composeFixtureArbitrary
);

function propertyParameters(): { seed: number; numRuns: number; path?: string } {
  const seed = boundedIntegerEnvironment('COMPOSITIONAL_PROPERTY_SEED', DEFAULT_PROPERTY_SEED, -0x80000000, 0x7fffffff);
  const numRuns = boundedIntegerEnvironment('COMPOSITIONAL_PROPERTY_RUNS', DEFAULT_PROPERTY_RUNS, 1, 250);
  const path = process.env.COMPOSITIONAL_PROPERTY_PATH;
  if (path === undefined || path === '') {return { seed, numRuns };}
  if (path.length > 256 || !/^\d+(?::\d+)*$/u.test(path) ||
      path.split(':').some(segment => Number(segment) > 10_000)) {
    throw new Error('COMPOSITIONAL_PROPERTY_PATH must be a bounded fast-check replay path');
  }
  return { seed, numRuns, path };
}

function boundedIntegerEnvironment(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {return fallback;}
  if (!/^-?\d+$/u.test(raw)) {throw new Error(`${name} must be an integer`);}
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
