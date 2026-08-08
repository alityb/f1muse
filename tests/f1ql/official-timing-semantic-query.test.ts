import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import {
  buildOfficialTimingSemanticQuery,
  computeOfficialTimingCandidateSetHash,
  computeOfficialTimingEvidenceHash,
  computeOfficialTimingQueryHash,
  enumerateOfficialTimingEvidence,
  OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION,
  OFFICIAL_TIMING_SEMANTIC_QUERY_VERSION,
  OFFICIAL_TIMING_SOURCE_ID,
  OfficialTimingSemanticError,
  verifyOfficialTimingEvidence
} from '../../src/f1ql/official-timing-semantic-query';
import { SEMANTIC_CATALOG } from '../../src/f1ql/semantic-catalog';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const CATALOG_V2_HASH = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256;

function matched(question: string): OfficialTimingQuestionMatch {
  const result = parseOfficialTimingQuestion(question);
  if (result.type !== 'matched') {
    throw new Error(`expected match, got ${result.reason}`);
  }
  return result;
}

const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';
const WINDOW_MEDIAN_QUESTION = 'Compare the official median race lap time of Max Verstappen and Fernando Alonso over laps 10 to 20 at the 2022 Belgian Grand Prix';

describe('official timing semantic query v3', () => {
  it('builds the event-mean query with question-ordered drivers and fixed scope', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const query = buildOfficialTimingSemanticQuery(question, CATALOG_V2);
    expect(query.version).toBe(OFFICIAL_TIMING_SEMANTIC_QUERY_VERSION);
    expect(query.source_id).toBe(OFFICIAL_TIMING_SOURCE_ID);
    expect(query.metric_id).toBe('official_non_deleted_non_pit_event_mean_v1');
    expect(query.aggregation).toBe('arithmetic_mean_integer_milliseconds');
    expect(query.topology).toBe('same_source_scalar_comparison');
    expect(query.entities.map(entity => [entity.branch, entity.span.text])).toEqual([
      ['driver_a', 'Max Verstappen'],
      ['driver_b', 'Fernando Alonso']
    ]);
    expect(query.scopes).toEqual([
      { kind: 'season', concept: 'season', value: 2022, evidence: [question.season_span] },
      { kind: 'round', concept: 'round', value: 14, evidence: [question.event_span] },
      { kind: 'session', concept: 'session_type', value: 'R', evidence: [question.event_span] },
      { kind: 'event', value: '2022 Belgian Grand Prix', evidence: [question.event_span] }
    ]);
    expect(query.filters.map(filter => filter.kind)).toEqual(['entity', 'entity', 'literal']);
    expect(query.filters.some(filter => filter.kind === 'literal_range')).toBe(false);
    expect(query.outputs.map(output => [output.branch, output.function, output.concept])).toEqual([
      ['driver_a', 'arithmetic_mean_integer_milliseconds', 'lap_time_seconds'],
      ['driver_b', 'arithmetic_mean_integer_milliseconds', 'lap_time_seconds']
    ]);
    expect(query.comparison).toMatchObject({ relation: 'lower', delta: 'absolute', winner_on_equal: null, decimal_scale: 4 });
    expect(query.order_by).toHaveLength(1);
    expect(query.limit.value).toBe(1);
  });

  it('builds the window-median query with the inclusive lap range filter', () => {
    const question = matched(WINDOW_MEDIAN_QUESTION);
    const query = buildOfficialTimingSemanticQuery(question, CATALOG_V2);
    expect(query.metric_id).toBe('official_non_deleted_non_pit_window_median_v1');
    expect(query.aggregation).toBe('median_integer_milliseconds');
    const window = query.filters.find(filter => filter.kind === 'literal_range');
    expect(window).toMatchObject({ concept: 'lap_number', operator: 'range', min: 10, max: 20 });
    expect(query.filters).toHaveLength(4);
  });

  it('fails closed against the active catalog without the official source', () => {
    expect(() => buildOfficialTimingSemanticQuery(matched(EVENT_MEAN_QUESTION), SEMANTIC_CATALOG))
      .toThrowError(expect.objectContaining({ code: 'catalog_unsupported' }));
  });

  it('fails closed against doctored catalogs with wrong governance, family, or version', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const governance = structuredClone(CATALOG_V2) as any;
    governance.sources.find((source: any) => source.id === 'official_race_lap_timing').governance = 'verified';
    expect(() => buildOfficialTimingSemanticQuery(question, governance))
      .toThrowError(expect.objectContaining({ code: 'catalog_unsupported' }));
    const family = structuredClone(CATALOG_V2) as any;
    family.sources.find((source: any) => source.id === 'official_race_lap_timing').family_id = 'other_family';
    expect(() => buildOfficialTimingSemanticQuery(question, family))
      .toThrowError(expect.objectContaining({ code: 'catalog_unsupported' }));
    const injected = structuredClone(SEMANTIC_CATALOG) as any;
    injected.sources.push(structuredClone(
      (CATALOG_V2 as any).sources.find((source: any) => source.id === 'official_race_lap_timing')
    ));
    expect(() => buildOfficialTimingSemanticQuery(question, injected))
      .toThrowError(expect.objectContaining({ code: 'catalog_unsupported' }));
  });

  it('produces deterministic canonical hashes', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const first = buildOfficialTimingSemanticQuery(question, CATALOG_V2);
    const second = buildOfficialTimingSemanticQuery(question, CATALOG_V2);
    expect(computeOfficialTimingQueryHash(first)).toBe(computeOfficialTimingQueryHash(second));
    expect(computeOfficialTimingQueryHash(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enumerates exactly one candidate with provenance-branded evidence bound to catalog v2', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    expect(evidence.version).toBe(OFFICIAL_TIMING_SEMANTIC_EVIDENCE_VERSION);
    expect(evidence.candidates).toHaveLength(1);
    expect(evidence.catalog_hash).toBe(CATALOG_V2_HASH);
    expect(evidence.question_sha256).toBe(question.question_sha256);
    expect(evidence.candidate_set_hash).toBe(
      computeOfficialTimingCandidateSetHash(evidence.candidates, question.question_sha256, CATALOG_V2_HASH)
    );
    expect(computeOfficialTimingEvidenceHash(evidence)).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.candidates)).toBe(true);
  });

  it('verifies evidence by independent reproduction and rejects foreign or stale objects', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
    expect(verifyOfficialTimingEvidence(evidence, question, CATALOG_V2)).toBe(evidence);
    expect(() => verifyOfficialTimingEvidence(structuredClone(evidence), question, CATALOG_V2))
      .toThrowError(expect.objectContaining({ code: 'evidence_provenance_invalid' }));
    const other = enumerateOfficialTimingEvidence(matched(WINDOW_MEDIAN_QUESTION), CATALOG_V2);
    expect(() => verifyOfficialTimingEvidence(other, question, CATALOG_V2))
      .toThrowError(expect.objectContaining({ code: 'evidence_mismatch' }));
    expect(() => verifyOfficialTimingEvidence(null, question, CATALOG_V2))
      .toThrowError(OfficialTimingSemanticError);
    expect(() => verifyOfficialTimingEvidence(evidence, question, SEMANTIC_CATALOG))
      .toThrowError(expect.objectContaining({ code: 'catalog_unsupported' }));
  });

  it('rejects structurally invalid queries through the closed schema', () => {
    const question = matched(EVENT_MEAN_QUESTION);
    const query = buildOfficialTimingSemanticQuery(question, CATALOG_V2);
    const medianQuery = buildOfficialTimingSemanticQuery(matched(WINDOW_MEDIAN_QUESTION), CATALOG_V2);
    const mutations: Array<(draft: any) => void> = [
      draft => { draft.aggregation = 'median_integer_milliseconds'; },
      draft => { draft.outputs[0].function = 'median_integer_milliseconds'; },
      draft => { draft.outputs[0].concept = 'season'; },
      draft => { draft.entities = [draft.entities[1], draft.entities[0]]; },
      draft => { draft.entities[1].span = draft.entities[0].span; },
      draft => { draft.filters.push({ kind: 'literal_range', concept: 'lap_number', operator: 'range', min: 1, max: 5, evidence: draft.filters[0].evidence }); },
      draft => { draft.filters = draft.filters.filter((filter: any) => filter.kind === 'literal'); },
      draft => { draft.filters[1] = { ...draft.filters[1], branch: 'driver_a' }; },
      draft => { draft.scopes = [draft.scopes[0], draft.scopes[0], draft.scopes[1], draft.scopes[2]]; },
      draft => { draft.comparison.relation = 'higher'; },
      draft => { draft.limit.value = 2; },
      draft => { draft.source_id = 'event_classification'; },
      draft => { draft.extra = true; },
      draft => { draft.version = 2; },
      draft => { draft.metric_id = 'unknown_metric'; },
      draft => { draft.topology = 'single_source_aggregate'; },
      draft => { draft.order_by[0].direction = 'desc'; },
      draft => { draft.entities[0].span.end = draft.entities[0].span.start; },
      draft => { draft.scopes[0].evidence = []; }
    ];
    for (const mutate of mutations) {
      const draft = structuredClone(query) as any;
      mutate(draft);
      expect(() => computeOfficialTimingQueryHash(draft)).toThrow();
    }
    const withoutWindow = structuredClone(medianQuery) as any;
    withoutWindow.filters = withoutWindow.filters.filter((filter: any) => filter.kind !== 'literal_range');
    expect(() => computeOfficialTimingQueryHash(withoutWindow)).toThrow();
    const secondWindow = structuredClone(medianQuery) as any;
    secondWindow.filters = [
      secondWindow.filters[0],
      secondWindow.filters[2],
      secondWindow.filters[3],
      { kind: 'literal_range', concept: 'lap_number', operator: 'range', min: 30, max: 5, evidence: secondWindow.filters[0].evidence }
    ];
    expect(() => computeOfficialTimingQueryHash(secondWindow)).toThrow();
  });

  it('keeps both metrics distinct and deterministic across the grammar forms', () => {
    const meanA = buildOfficialTimingSemanticQuery(matched(EVENT_MEAN_QUESTION), CATALOG_V2);
    const meanB = buildOfficialTimingSemanticQuery(
      matched('Compare Max Verstappen and Fernando Alonso by official average race lap time at the 2022 Belgian Grand Prix'),
      CATALOG_V2
    );
    const median = buildOfficialTimingSemanticQuery(matched(WINDOW_MEDIAN_QUESTION), CATALOG_V2);
    expect(computeOfficialTimingQueryHash(meanA)).not.toBe(computeOfficialTimingQueryHash(meanB));
    expect(computeOfficialTimingQueryHash(meanA)).not.toBe(computeOfficialTimingQueryHash(median));
    expect(meanA.aggregation).toBe(meanB.aggregation);
    expect(meanA.entities.map(entity => [entity.branch, entity.span.text]))
      .toEqual(meanB.entities.map(entity => [entity.branch, entity.span.text]));
  });
});
