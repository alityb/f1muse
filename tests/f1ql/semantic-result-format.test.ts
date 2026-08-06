import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAnswerEnvelope } from '../../src/f1ql/answer-format';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { materializeAnswerTemplate } from '../../src/f1ql/answer-templates';
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
  formatSemanticPlanResultAsAnswerEnvelope,
  formatSemanticPlanResult,
  SEMANTIC_ANSWER_COMPATIBILITY_VERSION,
  SEMANTIC_RESULT_FORMAT_VERSION,
  SemanticResultFormatError
} from '../../src/f1ql/semantic-result-format';
import { executeSemanticPlanRowsOffline } from '../../scripts/support/semantic-plan-execution';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SemanticEvidence,
  SemanticLiteralSpan
} from '../../src/f1ql/semantic-query';
import { FINAL_STANDINGS_ROWS_CAVEAT } from '../../src/f1ql/final-standings-response-contract';
import {
  ANSWER_ENVELOPE_FIELD_ACCOUNTING,
  ANSWER_METADATA_FIELD_ACCOUNTING,
  canonicalizeAnswerFinalStandingsResponse,
  canonicalizeSemanticFinalStandingsResponse,
  SEMANTIC_ENVELOPE_FIELD_ACCOUNTING,
  SEMANTIC_METADATA_FIELD_ACCOUNTING,
  SEMANTIC_RESPONSE_EQUIVALENCE_VERSION
} from '../../src/f1ql/semantic-response-equivalence';

const STANDINGS = 'List driver and championship points from final 2025 driver standings.';
const FILTERED_STANDINGS = 'What were Charles Leclerc final standings points in 2024?';
const PAIR_STANDINGS = 'Final 2025 standings points for Lando Norris and Oscar Piastri.';
const REVERSED_PAIR_STANDINGS = 'Final 2025 standings points for Oscar Piastri and Lando Norris.';
const RACE_METADATA = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const SELECTED_RACE_METADATA = 'List driver, finishing position, race date, event name, and circuit identifier for Lando Norris and Oscar Piastri from round 1 of final 2025 race classification and event metadata.';
const SELECTED_QUALIFYING_METADATA = 'List driver, qualifying position, race date, event name, and circuit identifier for Lando Norris and Oscar Piastri from round 1 of final 2025 qualifying classification and event metadata.';
const RACE_CLASSIFICATION = 'List driver and finishing position from round 1 of final 2025 race classification.';
const QUALIFYING_CLASSIFICATION = 'List driver and qualifying position from round 1 of final 2025 qualifying classification.';
const COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
const UNFILTERED_COMPOSE = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification in final 2025.';
const SCALAR_COUNT = 'Show count of qualifying position in final 2025 qualifying classification.';
const RACE_SCALAR_COUNT = 'Show count of finishing position in final 2025 race classification.';
const FILTERED_RACE_SCALAR_COUNT = 'Show count of finishing position for Norris in final 2025 race classification.';
const FILTERED_QUALIFYING_SCALAR_COUNT = 'Show count of qualifying position for Norris in final 2025 qualifying classification.';
const QUALIFYING_COUNT_RANK = 'Show top 10 drivers by count of qualifying position in final 2025 qualifying classification.';
const RACE_COUNT_RANK = 'Show top 10 drivers by count of finishing position in final 2025 race classification.';
const EVENT_DATE = 'List race date from round 1 of final 2025 event metadata.';
const EVENT_CIRCUIT = 'List circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME_DATE = 'List event name and race date from round 1 of final 2025 event metadata.';
const EVENT_DATE_CIRCUIT = 'List race date and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME_CIRCUIT = 'List event name and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_ALL_METADATA = 'List race date, event name, and circuit identifier from round 1 of final 2025 event metadata.';
const EVENT_NAME = 'List Grand Prix name from round 1 of final 2025 event metadata.';
const STANDINGS_POSITION_RANK = 'Rank Max Verstappen, Lando Norris, and Oscar Piastri by championship position in final 2025 driver standings.';
const RACE_POSITION_RANK = 'Rank drivers Max Verstappen, Lando Norris, and Oscar Piastri by finishing position from round 1 of final 2025 race classification.';
const QUALIFYING_POSITION_RANK = 'Rank drivers Max Verstappen, Lando Norris, and Oscar Piastri by qualifying position from round 1 of final 2025 qualifying classification.';
const SINGLETON_STANDINGS_POSITION = 'List driver and championship position for Norris from final 2025 driver standings.';
const SINGLETON_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Norris from final 2025 driver standings.';
const MULTI_STANDINGS_POSITION = 'List driver and championship position for Lando Norris and Oscar Piastri from final 2025 driver standings.';
const MULTI_STANDINGS_SUMMARY = 'List driver, championship position, and championship points for Charles Leclerc, George Russell, Lando Norris, Oscar Piastri from final 2025 driver standings.';

describe('generic proven semantic result formatting', () => {
  it('derives standings metadata and preserves the complete family wire contract', async () => {
    const prepared = await prepare(STANDINGS);
    const rows = [
      { driver_id: 'charles-leclerc', points: null, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    const compatible = formatSemanticPlanResultAsAnswerEnvelope(execution);

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
    expect(formatted.metadata.caveats).toEqual([]);
    expect(formatted.metadata.advisories)
      .toContain('Do not derive championship points or rank from race classification points.');
    expect(formatted.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 2, row_limit: 100 });
    expect(formatted.rows[1].points).toBe('357.000');
    expect(Object.keys(formatted.rows[1])).toEqual(['driver_id', 'points']);
    expect(Object.isFrozen(formatted)).toBe(true);
    expect(Object.isFrozen(formatted.metadata.columns)).toBe(true);

    const legacyProgram = materializeAnswerTemplate('final_standings_points', { season: 2025 });
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('legacy oracle fixture was not authorized');
    const legacy = buildAnswerEnvelope(
      legacyProgram,
      decision.capability,
      rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row)
    );
    expect(Buffer.from(JSON.stringify(canonicalizeSemanticFinalStandingsResponse(formatted))))
      .toEqual(Buffer.from(JSON.stringify(canonicalizeAnswerFinalStandingsResponse(legacy))));
    expect(Buffer.from(JSON.stringify(compatible))).toEqual(Buffer.from(JSON.stringify(legacy)));
    expect(Object.isFrozen(compatible)).toBe(true);
    expect(Object.isFrozen(compatible.rows)).toBe(true);
    expect(Object.isFrozen(compatible.rows[0])).toBe(true);
    expect(SEMANTIC_RESPONSE_EQUIVALENCE_VERSION).toBe('semantic-response-equivalence-v4');
    expect(SEMANTIC_ANSWER_COMPATIBILITY_VERSION).toBe('semantic-answer-compatibility-v4');
    expect([
      ANSWER_ENVELOPE_FIELD_ACCOUNTING,
      ANSWER_METADATA_FIELD_ACCOUNTING,
      SEMANTIC_ENVELOPE_FIELD_ACCOUNTING,
      SEMANTIC_METADATA_FIELD_ACCOUNTING
    ].every(Object.isFrozen)).toBe(true);

    const boundaryRows = Array.from({ length: 101 }, (_, index) => ({
      driver_id: `driver-${String(index).padStart(3, '0')}`,
      points: '1.000',
      [PLANNED_INTEGRITY_FIELD]: true
    }));
    for (const [observedRows, expectedCoverage] of [
      [0, 'empty'],
      [99, 'sufficient'],
      [100, 'sufficient'],
      [101, 'possibly_truncated']
    ] as const) {
      const boundaryExecution = await executeSemanticPlanRowsOffline(
        prepared.proof,
        prepared.profile_id,
        boundaryRows.slice(0, observedRows)
      );
      const generic = formatSemanticPlanResult(boundaryExecution);
      const compatibility = formatSemanticPlanResultAsAnswerEnvelope(boundaryExecution);
      const family = buildAnswerEnvelope(
        legacyProgram,
        decision.capability,
        boundaryRows.slice(0, Math.min(observedRows, 100)).map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row),
        { row_limit: 100, has_more_rows: observedRows === 101 }
      );
      expect(Buffer.from(JSON.stringify(canonicalizeSemanticFinalStandingsResponse(generic))))
        .toEqual(Buffer.from(JSON.stringify(canonicalizeAnswerFinalStandingsResponse(family))));
      expect(Buffer.from(JSON.stringify(compatibility))).toEqual(Buffer.from(JSON.stringify(family)));
      expect(generic.metadata.coverage.status).toBe(expectedCoverage);
      expect(generic.metadata.caveats)
        .toEqual(observedRows === 0
          ? ['empty_result_is_not_zero']
          : observedRows === 101 ? [FINAL_STANDINGS_ROWS_CAVEAT] : []);
      expect(generic.rows).toHaveLength(Math.min(observedRows, 100));
    }

    const unicodeRows = [
      { driver_id: 'driver-a', points: '1.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'driver-\uE000', points: '2.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'driver-\u{10000}', points: '3.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const unicodeExecution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, unicodeRows);
    const unicodeGeneric = formatSemanticPlanResult(unicodeExecution);
    const unicodeCompatibility = formatSemanticPlanResultAsAnswerEnvelope(unicodeExecution);
    const unicodeFamily = buildAnswerEnvelope(
      legacyProgram,
      decision.capability,
      unicodeRows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row)
    );
    expect(canonicalizeSemanticFinalStandingsResponse(unicodeGeneric))
      .toEqual(canonicalizeAnswerFinalStandingsResponse(unicodeFamily));
    expect(Buffer.from(JSON.stringify(unicodeCompatibility))).toEqual(Buffer.from(JSON.stringify(unicodeFamily)));

    for (const forgery of [
      null,
      { ...execution },
      structuredClone(execution),
      formatted,
      { ...formatted },
      Object.freeze({ ...formatted }),
      legacy,
      { ...legacy }
    ]) {
      expect(() => formatSemanticPlanResultAsAnswerEnvelope(forgery)).toThrow('provenance');
    }
  });

  it('preserves the exact singleton-filtered standings wire contract and rejects incomplete rows', async () => {
    const charles = span(FILTERED_STANDINGS, 'Charles Leclerc');
    const prepared = await prepare(
      FILTERED_STANDINGS,
      [{ type: 'driver', span: charles }],
      [{ ...charles, candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] }]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: [],
      linked_entities: [{ type: 'driver', selected_id: 'charles-leclerc' }],
      branches: [{
        predicates: [
          { concept: { concept_id: 'driver_id' }, operator: 'eq', value: 'charles-leclerc' },
          { concept: { concept_id: 'season' }, operator: 'eq', value: 2024 }
        ],
        fixed_grain: ['driver_id', 'season'], residual_grain: []
      }],
      work: { requested_rows: 1 }
    });
    const row = { driver_id: 'charles-leclerc', points: '356.000', [PLANNED_INTEGRITY_FIELD]: true };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    const generic = formatSemanticPlanResult(execution);
    const compatible = formatSemanticPlanResultAsAnswerEnvelope(execution);
    expect(generic.metadata.scope).toEqual([
      { source_id: 'driver_standings', concept_id: 'driver_id', label: 'driver', operator: 'eq', values: ['charles-leclerc'] },
      { source_id: 'driver_standings', concept_id: 'season', label: 'season', operator: 'eq', values: [2024] }
    ]);
    expect(generic.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 1, row_limit: 1 });

    const legacyProgram = materializeAnswerTemplate('final_standings_points', {
      season: 2024, driver_ids: ['charles-leclerc']
    });
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('filtered legacy oracle fixture was not authorized');
    const legacy = buildAnswerEnvelope(legacyProgram, decision.capability, [{
      driver_id: 'charles-leclerc', points: '356.000'
    }]);
    expect(canonicalizeSemanticFinalStandingsResponse(generic))
      .toEqual(canonicalizeAnswerFinalStandingsResponse(legacy));
    expect(Buffer.from(JSON.stringify(compatible))).toEqual(Buffer.from(JSON.stringify(legacy)));
    expect(() => buildAnswerEnvelope(legacyProgram, decision.capability, []))
      .toThrow('Final standings result collection evidence was invalid');
    expect(() => buildAnswerEnvelope(legacyProgram, decision.capability, [{
      driver_id: 'lando-norris', points: '374.000'
    }])).toThrow('Filtered final standings drivers were invalid');
    const malformedProgram = structuredClone(legacyProgram);
    if (malformedProgram.root.op !== 'aggregate' || malformedProgram.root.input.op !== 'filter') {
      throw new Error('filtered legacy fixture had the wrong shape');
    }
    malformedProgram.root.input.where.driver_id = ['INVALID/ID'];
    expect(() => canonicalizeAnswerFinalStandingsResponse({
      ...legacy,
      program: malformedProgram
    })).toThrow('outside the reviewed standings overlap');
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...generic,
      metadata: { ...generic.metadata, coverage: { ...generic.metadata.coverage, row_limit: 100 } }
    }))).toThrow('coverage did not match');
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...generic,
      metadata: {
        ...generic.metadata,
        scope: generic.metadata.scope.map(scope => scope.concept_id === 'driver_id'
          ? { ...scope, values: ['lando-norris'] }
          : scope)
      }
    }))).toThrow('Filtered final standings drivers were invalid');

    const emptyExecution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, []);
    expect(() => formatSemanticPlanResult(emptyExecution)).toThrow('exactly one row');
    const wrongExecution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...row, driver_id: 'lando-norris'
    }]);
    expect(() => formatSemanticPlanResult(wrongExecution)).toThrow('outside its proven predicate');
    const duplicateExecution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row, row]);
    expect(() => formatSemanticPlanResult(duplicateExecution))
      .toThrow('Final standings result collection evidence was invalid');
  });

  it('preserves the exact two-driver standings wire contract and rejects partial or substituted membership', async () => {
    const lando = span(PAIR_STANDINGS, 'Lando Norris');
    const oscar = span(PAIR_STANDINGS, 'Oscar Piastri');
    const prepared = await prepare(
      PAIR_STANDINGS,
      [{ type: 'driver', span: lando }, { type: 'driver', span: oscar }],
      [
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: ['driver_id'],
      linked_entities: [
        { type: 'driver', selected_id: 'lando-norris' },
        { type: 'driver', selected_id: 'oscar-piastri' }
      ],
      branches: [{
        predicates: [
          { concept: { concept_id: 'driver_id' }, operator: 'in', values: ['lando-norris', 'oscar-piastri'] },
          { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
        ],
        fixed_grain: ['season'], residual_grain: ['driver_id']
      }],
      work: { requested_rows: 100 }
    });
    const rows = [
      { driver_id: 'lando-norris', points: '374.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', points: '356.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const generic = formatSemanticPlanResult(execution);
    const compatible = formatSemanticPlanResultAsAnswerEnvelope(execution);
    expect(generic.metadata.scope).toEqual([
      {
        source_id: 'driver_standings', concept_id: 'driver_id', label: 'driver', operator: 'in',
        values: ['lando-norris', 'oscar-piastri']
      },
      { source_id: 'driver_standings', concept_id: 'season', label: 'season', operator: 'eq', values: [2025] }
    ]);
    expect(generic.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 2, row_limit: 100 });

    const legacyProgram = materializeAnswerTemplate('final_standings_points', {
      season: 2025, driver_ids: ['lando-norris', 'oscar-piastri']
    });
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('pair legacy oracle fixture was not authorized');
    const legacy = buildAnswerEnvelope(legacyProgram, decision.capability, rows.map(({
      [PLANNED_INTEGRITY_FIELD]: _, ...row
    }) => row));
    expect(canonicalizeSemanticFinalStandingsResponse(generic))
      .toEqual(canonicalizeAnswerFinalStandingsResponse(legacy));
    expect(canonicalizeSemanticFinalStandingsResponse(generic).overlap_id)
      .toBe('driver_pair_filtered_final_standings_points');
    expect(Buffer.from(JSON.stringify(compatible))).toEqual(Buffer.from(JSON.stringify(legacy)));

    for (const mutation of [
      [],
      [rows[0]],
      [rows[0], rows[0]],
      [rows[0], { ...rows[1], driver_id: 'max-verstappen' }],
      [rows[1], rows[0]]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, mutation);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
    expect(() => buildAnswerEnvelope(legacyProgram, decision.capability, [{
      driver_id: 'lando-norris', points: '374.000'
    }])).toThrow('Final standings result collection evidence was invalid');
    expect(() => buildAnswerEnvelope(legacyProgram, decision.capability, [
      { driver_id: 'lando-norris', points: '374.000' },
      { driver_id: 'max-verstappen', points: '421.000' }
    ])).toThrow('Filtered final standings drivers were invalid');
  });

  it.each([3, 4] as const)('preserves complete compatibility for %i filtered drivers', async cardinality => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, cardinality);
    const question = `List driver and championship points for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
    const entities = drivers.map(([name]) => ({ type: 'driver' as const, span: span(question, name) }));
    const mentions = drivers.map(([name, id]) => ({
      ...span(question, name), candidates: [id], active_candidates: [id]
    }));
    const prepared = await prepare(question, entities, mentions);
    const rows = drivers.map(([, driver_id], index) => ({
      driver_id, points: `${400 - index}.000`, [PLANNED_INTEGRITY_FIELD]: true
    })).sort((left, right) => Buffer.compare(Buffer.from(left.driver_id), Buffer.from(right.driver_id)));
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const generic = formatSemanticPlanResult(execution);
    const compatible = formatSemanticPlanResultAsAnswerEnvelope(execution);
    const driverIds = rows.map(row => row.driver_id);
    const legacyProgram = materializeAnswerTemplate('final_standings_points', {
      season: 2025, driver_ids: driverIds
    });
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('multi-driver legacy oracle fixture was not authorized');
    const legacy = buildAnswerEnvelope(legacyProgram, decision.capability, rows.map(({
      [PLANNED_INTEGRITY_FIELD]: _, ...row
    }) => row));
    expect(generic.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: cardinality, row_limit: 100 });
    expect(canonicalizeSemanticFinalStandingsResponse(generic).overlap_id)
      .toBe('multi_driver_filtered_final_standings_points');
    expect(Buffer.from(JSON.stringify(compatible))).toEqual(Buffer.from(JSON.stringify(legacy)));

    const partial = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows.slice(0, -1));
    expect(() => formatSemanticPlanResult(partial)).toThrow(SemanticResultFormatError);
  });

  it('formats a complete selected-driver official-position ranking and rejects incomplete rank evidence', async () => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ] as const;
    const prepared = await prepare(
      STANDINGS_POSITION_RANK,
      drivers.map(([name]) => ({ type: 'driver' as const, span: span(STANDINGS_POSITION_RANK, name) })),
      drivers.map(([name, id]) => ({
        ...span(STANDINGS_POSITION_RANK, name), candidates: [id], active_candidates: [id]
      }))
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: ['driver_id'],
      work: { requested_rows: 100 }
    });
    const rows = [
      { driver_id: 'oscar-piastri', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', championship_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      answer: {
        headline: 'Final 2025 driver standings result.',
        facts: [
          { subject: 'oscar-piastri', values: { championship_position: '1' } },
          { subject: 'lando-norris', values: { championship_position: '2' } },
          { subject: 'max-verstappen', values: { championship_position: '3' } }
        ]
      },
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 3, row_limit: 100 },
        ordering: [
          { output_id: 'championship_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    for (const mutation of [
      [],
      rows.slice(0, 2),
      [rows[0], rows[0], rows[2]],
      [rows[1], rows[0], rows[2]],
      [rows[0], { ...rows[1], driver_id: 'charles-leclerc' }, rows[2]],
      [rows[0], { ...rows[1], championship_position: 1 }, rows[2]],
      [rows[0], { ...rows[1], championship_position: null }, rows[2]],
      [rows[0], { ...rows[1], [PLANNED_INTEGRITY_FIELD]: false }, rows[2]]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, mutation);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }

    const singletonQuestion = 'List driver, finishing position, and race date for Lando Norris from round 1 of final 2025 race classification and event metadata.';
    const singletonSpan = span(singletonQuestion, 'Lando Norris');
    const singleton = await prepare(
      singletonQuestion,
      [{ type: 'driver', span: singletonSpan }],
      [{ ...singletonSpan, candidates: ['lando-norris'], active_candidates: ['lando-norris'] }],
      { type: 'resolved', season: 2025, round: 1 }
    );
    expect(singleton.plan).toMatchObject({
      topology: 'row_dimension_join', output_grain: [], work: { requested_rows: 1 }
    });
    const singletonRow = {
      driver_id: 'lando-norris', finishing_position: 1, date: '2025-03-16',
      [PLANNED_INTEGRITY_FIELD]: true
    };
    const singletonExecution = await executeSemanticPlanRowsOffline(
      singleton.proof, singleton.profile_id, [singletonRow]
    );
    expect(formatSemanticPlanResult(singletonExecution).rows).toEqual([{
      driver_id: 'lando-norris', finishing_position: 1, date: '2025-03-16'
    }]);
    const emptySingleton = await executeSemanticPlanRowsOffline(singleton.proof, singleton.profile_id, []);
    expect(() => formatSemanticPlanResult(emptySingleton)).toThrow('exactly one row');
  });

  it('formats exactly one selected driver recorded final championship position', async () => {
    const norris = span(SINGLETON_STANDINGS_POSITION, 'Norris');
    const prepared = await prepare(
      SINGLETON_STANDINGS_POSITION,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const row = {
      driver_id: 'lando-norris', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true
    };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ driver_id: 'lando-norris', championship_position: 1 }],
      answer: { facts: [{ subject: 'lando-norris', values: { championship_position: '1' } }] },
      metadata: {
        scope: [
          {
            source_id: 'driver_standings', concept_id: 'driver_id',
            operator: 'eq', values: ['lando-norris']
          },
          {
            source_id: 'driver_standings', concept_id: 'season', operator: 'eq', values: [2025]
          }
        ],
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    for (const position of [null, 31]) {
      const variant = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
        ...row, championship_position: position
      }]);
      const formatted = formatSemanticPlanResult(variant);
      expect(formatted.rows).toEqual([{
        driver_id: 'lando-norris', championship_position: position
      }]);
      if (position === null) {
        expect(formatted.metadata.caveats).toContain('Null is not a calculated championship rank.');
      }
    }
    for (const rows of [
      [],
      [{ ...row, driver_id: 'other-driver' }],
      [{ ...row, championship_position: 0 }],
      [{ ...row, [PLANNED_INTEGRITY_FIELD]: false }],
      [row, { ...row, championship_position: 2 }]
    ]) {
      const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
      expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
    }
  });

  it('formats one selected driver recorded final championship position and points', async () => {
    const norris = span(SINGLETON_STANDINGS_SUMMARY, 'Norris');
    const prepared = await prepare(
      SINGLETON_STANDINGS_SUMMARY,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const row = {
      driver_id: 'lando-norris', championship_position: 1, points: '357.000',
      [PLANNED_INTEGRITY_FIELD]: true
    };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ driver_id: 'lando-norris', championship_position: 1, points: '357.000' }],
      answer: {
        facts: [{ subject: 'lando-norris', values: { championship_position: '1', points: '357' } }]
      },
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    for (const [championship_position, points] of [
      [null, '357.000'],
      [1, null],
      [31, '357.000']
    ] as const) {
      const variant = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
        ...row, championship_position, points
      }]);
      expect(formatSemanticPlanResult(variant).rows).toEqual([{
        driver_id: 'lando-norris', championship_position, points
      }]);
    }

    const { points: _, ...missingPoints } = row;
    const { championship_position: __, ...missingPosition } = row;
    for (const rows of [
      [],
      [{ ...row, driver_id: 'other-driver' }],
      [{ ...row, championship_position: 0 }],
      [{ ...row, points: 357 }],
      [{ ...row, extra: true }],
      [missingPoints],
      [missingPosition],
      [{ ...row, [PLANNED_INTEGRITY_FIELD]: false }],
      [row, { ...row, championship_position: 2 }]
    ]) {
      const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
      expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
    }
  });

  it.each([2, 3, 4] as const)(
    'formats exact selected membership for %i-driver final championship position and points',
    async cardinality => {
      const drivers = [
        ['Charles Leclerc', 'charles-leclerc'],
        ['George Russell', 'george-russell'],
        ['Lando Norris', 'lando-norris'],
        ['Oscar Piastri', 'oscar-piastri']
      ].slice(0, cardinality);
      const question = cardinality === 4
        ? MULTI_STANDINGS_SUMMARY
        : `List driver, championship position, and championship points for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
      const prepared = await prepare(
        question,
        drivers.map(([name]) => ({ type: 'driver' as const, span: span(question, name) })),
        drivers.map(([name, id]) => ({
          ...span(question, name), candidates: [id], active_candidates: [id]
        }))
      );
      expect(prepared.plan).toMatchObject({
        topology: 'single_source_rows', output_grain: ['driver_id'], work: { requested_rows: 100 }
      });
      const rows = drivers.map(([, driver_id], index) => ({
        driver_id,
        championship_position: index < 2 ? 3 : null,
        points: index % 2 === 0 ? `${250 - index}.500` : null,
        [PLANNED_INTEGRITY_FIELD]: true
      }));
      const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
      const formatted = formatSemanticPlanResult(execution);
      expect(formatted.rows).toEqual(rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row));
      expect(formatted.metadata.coverage).toEqual({
        status: 'sufficient', rows_returned: cardinality, row_limit: 100
      });
      expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

      for (const invalidRows of [
        rows.slice(0, -1),
        [rows[0], ...rows.slice(0, -1)],
        rows.map((row, index) => index === cardinality - 1 ? { ...row, driver_id: 'other-driver' } : row),
        [...rows].reverse(),
        rows.map((row, index) => index === 0 ? { ...row, points: 250 } : row)
      ]) {
        const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, invalidRows);
        expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
      }
    }
  );

  it('formats exact selected membership while preserving nullable and equal championship positions', async () => {
    const lando = span(MULTI_STANDINGS_POSITION, 'Lando Norris');
    const oscar = span(MULTI_STANDINGS_POSITION, 'Oscar Piastri');
    const prepared = await prepare(
      MULTI_STANDINGS_POSITION,
      [{ type: 'driver', span: lando }, { type: 'driver', span: oscar }],
      [
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_rows',
      output_grain: ['driver_id'],
      branches: [{
        predicates: [
          {
            concept: { concept_id: 'driver_id' }, operator: 'in',
            values: ['lando-norris', 'oscar-piastri']
          },
          { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
        ]
      }],
      work: { requested_rows: 100 }
    });
    const rows = [
      { driver_id: 'lando-norris', championship_position: null, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', championship_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [
        { driver_id: 'lando-norris', championship_position: null },
        { driver_id: 'oscar-piastri', championship_position: null }
      ],
      metadata: {
        scope: [
          {
            source_id: 'driver_standings', concept_id: 'driver_id', operator: 'in',
            values: ['lando-norris', 'oscar-piastri']
          },
          { source_id: 'driver_standings', concept_id: 'season', operator: 'eq', values: [2025] }
        ],
        coverage: { status: 'sufficient', rows_returned: 2, row_limit: 100 },
        ordering: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(formatted.metadata.caveats).toContain('Null is not a calculated championship rank.');
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    for (const positions of [[2, 2], [31, 31]] as const) {
      const variant = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows.map((row, index) => ({
        ...row, championship_position: positions[index]
      })));
      expect(formatSemanticPlanResult(variant).rows.map(row => row.championship_position))
        .toEqual([...positions]);
    }
    for (const invalidRows of [
      [],
      [rows[0]],
      [rows[0], rows[0]],
      [rows[0], { ...rows[1], driver_id: 'charles-leclerc' }],
      [rows[1], rows[0]],
      [rows[0], { ...rows[1], championship_position: 0 }],
      [rows[0], { ...rows[1], [PLANNED_INTEGRITY_FIELD]: false }]
    ]) {
      const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, invalidRows);
      expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
    }
  });

  it('preserves canonical wire bytes for the exact Oscar-first pair wording', async () => {
    const oscar = span(REVERSED_PAIR_STANDINGS, 'Oscar Piastri');
    const lando = span(REVERSED_PAIR_STANDINGS, 'Lando Norris');
    const prepared = await prepare(
      REVERSED_PAIR_STANDINGS,
      [{ type: 'driver', span: oscar }, { type: 'driver', span: lando }],
      [
        { ...oscar, candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] },
        { ...lando, candidates: ['lando-norris'], active_candidates: ['lando-norris'] }
      ]
    );
    expect(prepared.plan.linked_entities.map(entity => entity.selected_id))
      .toEqual(['oscar-piastri', 'lando-norris']);
    expect(prepared.plan.branches[0].predicates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        concept: { source_id: 'driver_standings', concept_id: 'driver_id' },
        operator: 'in', values: ['lando-norris', 'oscar-piastri']
      })
    ]));
    const rows = [
      { driver_id: 'lando-norris', points: '374.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', points: '356.000', [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const compatible = formatSemanticPlanResultAsAnswerEnvelope(execution);
    const legacyProgram = materializeAnswerTemplate('final_standings_points', {
      season: 2025, driver_ids: ['lando-norris', 'oscar-piastri']
    });
    const decision = authorizeAnswerProgram(legacyProgram);
    if (decision.type !== 'approved') throw new Error('pair legacy oracle fixture was not authorized');
    const legacy = buildAnswerEnvelope(legacyProgram, decision.capability, rows.map(({
      [PLANNED_INTEGRITY_FIELD]: _, ...row
    }) => row));
    expect(Buffer.from(JSON.stringify(compatible))).toEqual(Buffer.from(JSON.stringify(legacy)));
  });

  it('fails closed when canonical response metadata, schema, or row order drifts', async () => {
    const prepared = await prepare(STANDINGS);
    const semantic = await executeAndFormat(prepared, [
      { driver_id: 'driver-a', points: '1.000', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'driver-b', points: '2.000', [PLANNED_INTEGRITY_FIELD]: true }
    ]);
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...semantic,
      metadata: { ...semantic.metadata, ordering: [{ output_id: 'points', direction: 'desc', nulls: 'first' }] }
    }))).toThrow('metadata did not match');
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...semantic,
      metadata: { ...semantic.metadata, unaccounted: true }
    }) as typeof semantic)).toThrow('metadata fields were invalid');
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...semantic,
      metadata: {
        ...semantic.metadata,
        columns: [{ ...semantic.metadata.columns[0], label: 'substituted' }, semantic.metadata.columns[1]]
      }
    }))).toThrow('metadata did not match');
    const sparseAdvisories = new Array(semantic.metadata.advisories!.length);
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...semantic,
      metadata: { ...semantic.metadata, advisories: sparseAdvisories }
    }))).toThrow('advisories fields were invalid');
    let columnAccessed = false;
    const accessorColumns = [...semantic.metadata.columns];
    Object.defineProperty(accessorColumns, 0, {
      enumerable: true,
      get: () => {columnAccessed = true; return semantic.metadata.columns[0];}
    });
    expect(() => canonicalizeSemanticFinalStandingsResponse(Object.freeze({
      ...semantic,
      metadata: { ...semantic.metadata, columns: accessorColumns }
    }))).toThrow('columns entries were invalid');
    expect(columnAccessed).toBe(false);

    const program: F1QLProgram = {
      version: 1,
      root: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
        group_by: ['driver_id'],
        measures: [{ as: 'points', function: 'max', field: 'points' }]
      }
    };
    const decision = authorizeAnswerProgram(program);
    if (decision.type !== 'approved') throw new Error('legacy oracle fixture was not authorized');
    const validRows = [
      { driver_id: 'driver-a', points: '1.000' },
      { driver_id: 'driver-b', points: '2.000' }
    ];
    const legacy = buildAnswerEnvelope(program, decision.capability, [
      { driver_id: 'driver-b', points: '2.000' },
      { driver_id: 'driver-a', points: '1.000' }
    ]);
    expect(() => canonicalizeAnswerFinalStandingsResponse(legacy)).toThrow('canonical C ordering');
    expect(() => canonicalizeAnswerFinalStandingsResponse({
      ...buildAnswerEnvelope(program, decision.capability, [{ driver_id: 'driver-a', points: '1.000' }]),
      metadata: {
        ...buildAnswerEnvelope(program, decision.capability, [{ driver_id: 'driver-a', points: '1.000' }]).metadata,
        source: 'current_driver_standings'
      }
    })).toThrow('provenance did not match');

    const overriddenRows = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(overriddenRows.rows, 'map', {
      value: () => [{ driver_id: 'driver-a', points: '999.000' }]
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse(overriddenRows)).toThrow('rows fields were invalid');

    let rowSlotAccessed = false;
    const accessorRows = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(accessorRows.rows, 0, {
      enumerable: true,
      get: () => {rowSlotAccessed = true; return validRows[0];}
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse(accessorRows)).toThrow('rows entries were invalid');
    expect(rowSlotAccessed).toBe(false);

    let rowValueAccessed = false;
    const accessorValue = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(accessorValue.rows[0], 'points', {
      enumerable: true,
      get: () => {rowValueAccessed = true; return '999.000';}
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse(accessorValue)).toThrow('row 0 fields were invalid');
    expect(rowValueAccessed).toBe(false);

    const answerToJson = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(answerToJson.answer, 'toJSON', {
      value: () => ({ headline: answerToJson.answer.headline, facts: answerToJson.answer.facts })
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse(answerToJson)).toThrow('answer fields were invalid');

    const extraCaveatField = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(extraCaveatField.metadata.caveats, 'hidden', { value: 'substituted' });
    expect(() => canonicalizeAnswerFinalStandingsResponse(extraCaveatField)).toThrow('caveats fields were invalid');

    const hiddenProgram = structuredClone(program);
    const hiddenProgramEnvelope = buildAnswerEnvelope(hiddenProgram, decision.capability, validRows.map(row => ({ ...row })));
    Object.defineProperty(hiddenProgramEnvelope.program, 'hidden', { value: true });
    expect(() => canonicalizeAnswerFinalStandingsResponse(hiddenProgramEnvelope)).toThrow('program fields were invalid');

    let seasonAccessed = false;
    const accessorProgram = structuredClone(program);
    const accessorProgramEnvelope = buildAnswerEnvelope(accessorProgram, decision.capability, validRows.map(row => ({ ...row })));
    if (accessorProgram.root.op !== 'aggregate' || accessorProgram.root.input.op !== 'filter') {
      throw new Error('legacy oracle fixture had the wrong shape');
    }
    Object.defineProperty(accessorProgram.root.input.where, 'season', {
      enumerable: true,
      get: () => {seasonAccessed = true; return 2025;}
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse(accessorProgramEnvelope)).toThrow('where fields were invalid');
    expect(seasonAccessed).toBe(false);

    const oversizedRows = buildAnswerEnvelope(program, decision.capability, validRows.map(row => ({ ...row })));
    expect(() => canonicalizeAnswerFinalStandingsResponse({
      ...oversizedRows,
      rows: new Array(1_000_000)
    })).toThrow('rows length was invalid');

    let oversizedKeysRead = false;
    const oversizedProxy = new Proxy(new Array(257), {
      ownKeys: target => {oversizedKeysRead = true; return Reflect.ownKeys(target);}
    });
    expect(() => canonicalizeAnswerFinalStandingsResponse({
      ...oversizedRows,
      rows: oversizedProxy
    })).toThrow('rows length was invalid');
    expect(oversizedKeysRead).toBe(false);
  });

  it('formats a complete metadata join without erasing nullable positions', async () => {
    const prepared = await prepare(RACE_METADATA, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [
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

  it('requires exact selected-driver membership and complete requested metadata across the safe join', async () => {
    const drivers = [
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ] as const;
    const prepared = await prepare(
      SELECTED_RACE_METADATA,
      drivers.map(([name]) => ({ type: 'driver' as const, span: span(SELECTED_RACE_METADATA, name) })),
      drivers.map(([name, id]) => ({
        ...span(SELECTED_RACE_METADATA, name), candidates: [id], active_candidates: [id]
      })),
      { type: 'resolved', season: 2025, round: 1 }
    );
    expect(prepared.plan).toMatchObject({
      topology: 'row_dimension_join',
      output_grain: ['driver_id'],
      work: { requested_rows: 100 }
    });
    expect(prepared.plan.branches[0]).toMatchObject({
      predicates: [
        { concept: { concept_id: 'driver_id' }, operator: 'in', values: ['lando-norris', 'oscar-piastri'] },
        { concept: { concept_id: 'round' }, operator: 'eq', value: 1 },
        { concept: { concept_id: 'season' }, operator: 'eq', value: 2025 }
      ]
    });
    const rows = [
      {
        driver_id: 'lando-norris', finishing_position: 1, date: '2025-03-16',
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      },
      {
        driver_id: 'oscar-piastri', finishing_position: null, date: '2025-03-16',
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      metadata: { coverage: { status: 'sufficient', rows_returned: 2, row_limit: 100 } },
      rows: rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row)
    });

    for (const mutation of [
      [],
      rows.slice(0, 1),
      [rows[0], rows[0]],
      [rows[0], { ...rows[1], driver_id: 'max-verstappen' }],
      [rows[0], { ...rows[1], date: null }],
      [rows[0], { ...rows[1], event_name: '   ' }]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, mutation);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
  });

  it('formats qualifying positions with non-null race metadata and exact selected membership', async () => {
    const drivers = [
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ] as const;
    const prepared = await prepare(
      SELECTED_QUALIFYING_METADATA,
      drivers.map(([name]) => ({ type: 'driver' as const, span: span(SELECTED_QUALIFYING_METADATA, name) })),
      drivers.map(([name, id]) => ({
        ...span(SELECTED_QUALIFYING_METADATA, name), candidates: [id], active_candidates: [id]
      })),
      { type: 'resolved', season: 2025, round: 1 }
    );
    expect(prepared.plan).toMatchObject({
      topology: 'row_dimension_join',
      source_graph: {
        source_ids: ['event_metadata', 'qualifying_classification'],
        row_relationship_ids: ['qualifying_event_metadata']
      },
      output_grain: ['driver_id'],
      work: { requested_rows: 100 }
    });
    const rows = [
      {
        driver_id: 'lando-norris', qualifying_position: 1, date: '2025-03-16',
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      },
      {
        driver_id: 'oscar-piastri', qualifying_position: null, date: '2025-03-16',
        event_name: 'Australian Grand Prix', circuit_id: 'albert-park',
        [PLANNED_INTEGRITY_FIELD]: true
      }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row)
    });
    for (const mutation of [
      [],
      rows.slice(0, 1),
      [rows[0], rows[0]],
      [rows[0], { ...rows[1], driver_id: 'max-verstappen' }],
      [rows[0], { ...rows[1], date: null }],
      [rows[0], { ...rows[1], date: '   ' }],
      [rows[0], { ...rows[1], event_name: null }],
      [rows[0], { ...rows[1], event_name: '   ' }],
      [rows[0], { ...rows[1], circuit_id: null }],
      [rows[0], { ...rows[1], circuit_id: '   ' }]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, mutation);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
  });

  it.each([
    RACE_CLASSIFICATION,
    QUALIFYING_CLASSIFICATION
  ])('does not mint result provenance for an unfiltered classification without complete coverage: %s', async question => {
    const prepared = await prepare(
      question, [], [], { type: 'resolved', season: 2025, round: 1 }
    );
    await expect(executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      driver_id: 'lando-norris',
      ...(question === RACE_CLASSIFICATION ? { finishing_position: 1 } : { qualifying_position: 1 }),
      [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('profile_rejected');
  });

  it.each([1, 2, 3, 4] as const)('requires exact one-event membership for %i selected drivers', async cardinality => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, cardinality);
    const question = `List driver and finishing position for ${drivers.map(([name]) => name).join(', ')} from round 1 of final 2025 race classification.`;
    const entities = drivers.map(([name]) => ({ type: 'driver' as const, span: span(question, name) }));
    const mentions = drivers.map(([name, id]) => ({
      ...span(question, name), candidates: [id], active_candidates: [id]
    }));
    const prepared = await prepare(
      question, entities, mentions, { type: 'resolved', season: 2025, round: 1 }
    );
    const rows = drivers.map(([, driver_id], index) => ({
      driver_id,
      finishing_position: index === cardinality - 1 ? null : index + 1,
      [PLANNED_INTEGRITY_FIELD]: true
    })).sort((left, right) => Buffer.compare(Buffer.from(left.driver_id), Buffer.from(right.driver_id)));
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted.rows).toHaveLength(cardinality);
    expect(formatted.metadata.scope.find(scope => scope.concept_id === 'driver_id')).toMatchObject({
      operator: cardinality === 1 ? 'eq' : 'in',
      values: rows.map(row => row.driver_id)
    });
    if (cardinality === 4) {
      expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
        answer: { headline: 'Final 2025 race classification result for round 1.' },
        metadata: {
          coverage: { status: 'sufficient', rows_returned: 4, row_limit: 100 },
          ordering: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]
        }
      });
      expect(formatted.metadata.sources.map(source => source.id)).toEqual(['event_classification']);
      expect(formatted.metadata.sources[0].coverage.certified)
        .toBe('No event-complete historical or steward-decision ledger claim.');
      expect(SEMANTIC_RESULT_FORMAT_VERSION).toBe('semantic-result-format-v27');
    }
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const partial = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows.slice(0, -1));
    expect(() => formatSemanticPlanResult(partial)).toThrow(SemanticResultFormatError);
    const substituted = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...rows[0], driver_id: 'max-verstappen'
    }]);
    expect(() => formatSemanticPlanResult(substituted)).toThrow(SemanticResultFormatError);
    const integrityFailed = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...rows[0], [PLANNED_INTEGRITY_FIELD]: false
    }]);
    expect(() => formatSemanticPlanResult(integrityFailed)).toThrow('failed source integrity');
  });

  it('preserves null and equal recorded positions in a complete selected-driver race ranking', async () => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ] as const;
    const prepared = await prepare(
      RACE_POSITION_RANK,
      drivers.map(([name]) => ({ type: 'driver' as const, span: span(RACE_POSITION_RANK, name) })),
      drivers.map(([name, id]) => ({
        ...span(RACE_POSITION_RANK, name), candidates: [id], active_candidates: [id]
      })),
      { type: 'resolved', season: 2025, round: 1 }
    );
    const rows = [
      { driver_id: 'lando-norris', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'oscar-piastri', finishing_position: null, [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [
        { driver_id: 'lando-norris', finishing_position: 2 },
        { driver_id: 'max-verstappen', finishing_position: 2 },
        { driver_id: 'oscar-piastri', finishing_position: null }
      ],
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 3, row_limit: 100 },
        ordering: [
          { output_id: 'finishing_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
    expect(formatted.metadata.caveats).toContain('Null is not a finish position.');
    expect(formatted.metadata.caveats)
      .toContain('Do not treat driver identity ordering as sporting precedence for equal or null positions.');
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const partial = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows.slice(0, -1));
    expect(() => formatSemanticPlanResult(partial)).toThrow(SemanticResultFormatError);
    const tieMisordered = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [rows[1], rows[0], rows[2]]);
    expect(() => formatSemanticPlanResult(tieMisordered)).toThrow('ordering');
    const nullMisordered = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [rows[2], rows[0], rows[1]]);
    expect(() => formatSemanticPlanResult(nullMisordered)).toThrow('ordering');
    const overflow = await executeSemanticPlanRowsOffline(
      prepared.proof,
      prepared.profile_id,
      Array.from({ length: 101 }, (_, index) => rows[index % rows.length])
    );
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it.each([1, 2, 3, 4] as const)('requires exact one-event qualifying membership for %i selected drivers', async cardinality => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, cardinality);
    const question = `List driver and qualifying position for ${drivers.map(([name]) => name).join(', ')} from round 1 of final 2025 qualifying classification.`;
    const entities = drivers.map(([name]) => ({ type: 'driver' as const, span: span(question, name) }));
    const mentions = drivers.map(([name, id]) => ({
      ...span(question, name), candidates: [id], active_candidates: [id]
    }));
    const prepared = await prepare(
      question, entities, mentions, { type: 'resolved', season: 2025, round: 1 }
    );
    const rows = drivers.map(([, driver_id], index) => ({
      driver_id,
      qualifying_position: index === cardinality - 1 ? null : index + 1,
      [PLANNED_INTEGRITY_FIELD]: true
    })).sort((left, right) => Buffer.compare(Buffer.from(left.driver_id), Buffer.from(right.driver_id)));
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted.rows).toHaveLength(cardinality);
    expect(formatted.metadata.scope.find(scope => scope.concept_id === 'driver_id')).toMatchObject({
      operator: cardinality === 1 ? 'eq' : 'in',
      values: rows.map(row => row.driver_id)
    });
    if (cardinality === 4) {
      expect(formatted).toMatchObject({
        format_version: 'semantic-result-format-v27',
        answer: { headline: 'Final 2025 qualifying classification result for round 1.' },
        metadata: {
          coverage: { status: 'sufficient', rows_returned: 4, row_limit: 100 },
          ordering: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }]
        }
      });
      expect(formatted.metadata.sources.map(source => source.id)).toEqual(['qualifying_classification']);
      expect(formatted.metadata.sources[0].coverage.certified)
        .toBe('No per-event complete historical qualifying or steward-decision claim.');
    }
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const partial = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows.slice(0, -1));
    expect(() => formatSemanticPlanResult(partial)).toThrow(SemanticResultFormatError);
    const substituted = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...rows[0], driver_id: 'max-verstappen'
    }]);
    expect(() => formatSemanticPlanResult(substituted)).toThrow(SemanticResultFormatError);
    const integrityFailed = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...rows[0], [PLANNED_INTEGRITY_FIELD]: false
    }]);
    expect(() => formatSemanticPlanResult(integrityFailed)).toThrow('failed source integrity');
  });

  it('requires complete non-null unique positions for selected-driver qualifying ranking', async () => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ] as const;
    const prepared = await prepare(
      QUALIFYING_POSITION_RANK,
      drivers.map(([name]) => ({ type: 'driver' as const, span: span(QUALIFYING_POSITION_RANK, name) })),
      drivers.map(([name, id]) => ({
        ...span(QUALIFYING_POSITION_RANK, name), candidates: [id], active_candidates: [id]
      })),
      { type: 'resolved', season: 2025, round: 1 }
    );
    const rows = [
      { driver_id: 'oscar-piastri', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'lando-norris', qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'max-verstappen', qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ];
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
        format_version: 'semantic-result-format-v27',
      rows: rows.map(({ [PLANNED_INTEGRITY_FIELD]: _, ...row }) => row),
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 3, row_limit: 100 },
        ordering: [
          { output_id: 'qualifying_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    for (const mutation of [
      [],
      rows.slice(0, 2),
      [rows[0], rows[0], rows[2]],
      [rows[1], rows[0], rows[2]],
      [rows[0], { ...rows[1], driver_id: 'charles-leclerc' }, rows[2]],
      [{ ...rows[1], qualifying_position: 1 }, rows[0], rows[2]],
      [rows[0], rows[1], { ...rows[2], qualifying_position: null }],
      [rows[0], { ...rows[1], [PLANNED_INTEGRITY_FIELD]: false }, rows[2]]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, mutation);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
    const overflow = await executeSemanticPlanRowsOffline(
      prepared.proof, prepared.profile_id, Array.from({ length: 101 }, (_, index) => rows[index % rows.length])
    );
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it('states aggregate locality semantics and accepts factual zero only with proven integrity', async () => {
    const norris = span(COMPOSE, 'Norris');
    const mention: SemanticDriverMention = {
      ...norris,
      candidates: ['lando-norris'],
      active_candidates: ['lando-norris']
    };
    const prepared = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [mention]);
    const formatted = await executeAndFormat(prepared, [{
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

  it('formats the exact zero-driver dual count without changing result format v25', async () => {
    const prepared = await prepare(UNFILTERED_COMPOSE);
    const row = {
      event_classification__count_finishing_position: 0,
      qualifying_classification__count_qualifying_position: 0,
      [PLANNED_INTEGRITY_FIELD]: true
    };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{
        event_classification__count_finishing_position: 0,
        qualifying_classification__count_qualifying_position: 0
      }],
      answer: { facts: [{
        subject: 'result 1',
        values: {
          event_classification__count_finishing_position: '0',
          qualifying_classification__count_qualifying_position: '0'
        }
      }] },
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{
          output_id: 'event_classification__count_finishing_position',
          direction: 'asc', nulls: 'last'
        }]
      }
    });
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted.metadata.scope.filter(item => item.concept_id === 'driver_id')).toEqual([]);
    expect(formatted.metadata.scope.filter(item => item.concept_id === 'season')).toEqual([
      { source_id: 'event_classification', concept_id: 'season', label: 'season', operator: 'eq', values: [2025] },
      { source_id: 'qualifying_classification', concept_id: 'season', label: 'season', operator: 'eq', values: [2025] }
    ]);

    const absentSource = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...row,
      [PLANNED_INTEGRITY_FIELD]: false
    }]);
    expect(() => formatSemanticPlanResult(absentSource)).toThrow(SemanticResultFormatError);
  });

  it('formats only one complete integrity-clean scalar count of recorded qualifying positions', async () => {
    const prepared = await prepare(SCALAR_COUNT);
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const row = { count_qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ count_qualifying_position: 2 }],
      answer: { facts: [{ subject: 'result 1', values: { count_qualifying_position: '2' } }] },
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        columns: [{
          id: 'count_qualifying_position', aggregation: 'count', units: 'count', nullable: false
        }],
        ordering: [{ output_id: 'count_qualifying_position', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const zero = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...row, count_qualifying_position: 0
    }]);
    expect(formatSemanticPlanResult(zero).rows).toEqual([{ count_qualifying_position: 0 }]);

    for (const rows of [
      [],
      [{ [PLANNED_INTEGRITY_FIELD]: true }],
      [{ ...row, extra: true }],
      [{ ...row, count_qualifying_position: null }],
      [{ ...row, count_qualifying_position: -1 }],
      [{ ...row, count_qualifying_position: 1.5 }],
      [{ ...row, count_qualifying_position: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...row, count_qualifying_position: '2' }],
      [{ ...row, [PLANNED_INTEGRITY_FIELD]: false }]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
    const overflow = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row, row]);
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it('formats only one complete integrity-clean scalar count of recorded race finishing positions', async () => {
    const prepared = await prepare(RACE_SCALAR_COUNT);
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'] },
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const row = { count_finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true };
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ count_finishing_position: 2 }],
      answer: { facts: [{ subject: 'result 1', values: { count_finishing_position: '2' } }] },
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        columns: [{
          id: 'count_finishing_position', aggregation: 'count', units: 'count', nullable: false
        }],
        ordering: [{ output_id: 'count_finishing_position', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const zero = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      ...row, count_finishing_position: 0
    }]);
    expect(formatSemanticPlanResult(zero).rows).toEqual([{ count_finishing_position: 0 }]);

    for (const rows of [
      [],
      [{ [PLANNED_INTEGRITY_FIELD]: true }],
      [{ ...row, extra: true }],
      [{ ...row, count_finishing_position: null }],
      [{ ...row, count_finishing_position: -1 }],
      [{ ...row, count_finishing_position: 1.5 }],
      [{ ...row, count_finishing_position: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...row, count_finishing_position: '2' }],
      [{ ...row, [PLANNED_INTEGRITY_FIELD]: false }]
    ]) {
      const mutated = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
      expect(() => formatSemanticPlanResult(mutated)).toThrow(SemanticResultFormatError);
    }
    const overflow = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [row, row]);
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it('formats the scalar race-position count only for one canonical resolved driver', async () => {
    const norris = span(FILTERED_RACE_SCALAR_COUNT, 'Norris');
    const prepared = await prepare(
      FILTERED_RACE_SCALAR_COUNT,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'] },
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      count_finishing_position: 2,
      [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ count_finishing_position: 2 }],
      metadata: {
        scope: [
          {
            source_id: 'event_classification', concept_id: 'driver_id',
            operator: 'eq', values: ['lando-norris']
          },
          {
            source_id: 'event_classification', concept_id: 'season',
            operator: 'eq', values: [2025]
          }
        ],
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 }
      }
    });
    const overflow = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [
      { count_finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { count_finishing_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it('formats the scalar qualifying-position count only for one canonical resolved driver', async () => {
    const norris = span(FILTERED_QUALIFYING_SCALAR_COUNT, 'Norris');
    const prepared = await prepare(
      FILTERED_QUALIFYING_SCALAR_COUNT,
      [{ type: 'driver', span: norris }],
      [{ ...norris, candidates: ['historical-norris', 'lando-norris'], active_candidates: ['lando-norris'] }]
    );
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['qualifying_classification'] },
      output_grain: [],
      work: { requested_rows: 1 }
    });
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      count_qualifying_position: 2,
      [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatSemanticPlanResult(execution)).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ count_qualifying_position: 2 }],
      metadata: {
        scope: [
          {
            source_id: 'qualifying_classification', concept_id: 'driver_id',
            operator: 'eq', values: ['lando-norris']
          },
          {
            source_id: 'qualifying_classification', concept_id: 'season',
            operator: 'eq', values: [2025]
          }
        ],
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 }
      }
    });
    const overflow = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [
      { count_qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true },
      { count_qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
    expect(() => formatSemanticPlanResult(overflow)).toThrow('collection evidence was incomplete');
  });

  it('formats a complete top-10 recorded qualifying-position count ranking', async () => {
    const prepared = await prepare(QUALIFYING_COUNT_RANK);
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      output_grain: ['driver_id'],
      work: { requested_rows: 10 }
    });
    const rows = Array.from({ length: 11 }, (_, index) => ({
      driver_id: `driver-${String(index).padStart(2, '0')}`,
      count_qualifying_position: index < 2 ? 20 : 20 - index,
      [PLANNED_INTEGRITY_FIELD]: true
    }));
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 10, row_limit: 10 },
        ordering: [
          { output_id: 'count_qualifying_position', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
    expect(formatted.rows).toHaveLength(10);
    expect(formatted.rows[0]).toEqual({ driver_id: 'driver-00', count_qualifying_position: 20 });
    expect(formatted.rows[1]).toEqual({ driver_id: 'driver-01', count_qualifying_position: 20 });
    expect(formatted.metadata.caveats).not.toContain('Output exceeded the proven 10-row response limit.');
    expect(() => formatSemanticPlanResultAsAnswerEnvelope(execution)).toThrow('no reviewed answer-envelope');

    const zero = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      driver_id: 'driver-zero', count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatSemanticPlanResult(zero).rows).toEqual([{
      driver_id: 'driver-zero', count_qualifying_position: 0
    }]);
    const empty = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, []);
    expect(() => formatSemanticPlanResult(empty)).toThrow('source evidence was incomplete');
    for (const invalidRows of [
      [rows[1], rows[0]],
      [{ ...rows[0], count_qualifying_position: -1 }],
      [{ ...rows[0], count_qualifying_position: 1.5 }],
      [{ ...rows[0], driver_id: '' }],
      [{ ...rows[0], [PLANNED_INTEGRITY_FIELD]: false }],
      [rows[0], rows[0]]
    ]) {
      const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, invalidRows);
      expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
    }
  });

  it('formats a complete top-10 recorded race finishing-position count ranking', async () => {
    const prepared = await prepare(RACE_COUNT_RANK);
    expect(prepared.plan).toMatchObject({
      topology: 'single_source_aggregate',
      source_graph: { source_ids: ['event_classification'] },
      output_grain: ['driver_id'],
      work: { requested_rows: 10 }
    });
    const rows = Array.from({ length: 11 }, (_, index) => ({
      driver_id: `driver-${String(index).padStart(2, '0')}`,
      count_finishing_position: index < 2 ? 20 : 20 - index,
      [PLANNED_INTEGRITY_FIELD]: true
    }));
    const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
    const formatted = formatSemanticPlanResult(execution);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 10, row_limit: 10 },
        ordering: [
          { output_id: 'count_finishing_position', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ]
      }
    });
    expect(formatted.rows).toHaveLength(10);
    expect(formatted.rows[0]).toEqual({ driver_id: 'driver-00', count_finishing_position: 20 });
    expect(formatted.rows[1]).toEqual({ driver_id: 'driver-01', count_finishing_position: 20 });

    const zero = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, [{
      driver_id: 'driver-zero', count_finishing_position: 0, [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatSemanticPlanResult(zero).rows).toEqual([{
      driver_id: 'driver-zero', count_finishing_position: 0
    }]);
    const empty = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, []);
    expect(() => formatSemanticPlanResult(empty)).toThrow('source evidence was incomplete');
    for (const invalidRows of [
      [rows[1], rows[0]],
      [{ ...rows[0], count_finishing_position: -1 }],
      [{ ...rows[0], count_finishing_position: 1.5 }],
      [{ ...rows[0], driver_id: '' }],
      [{ ...rows[0], [PLANNED_INTEGRITY_FIELD]: false }],
      [rows[0], rows[0]]
    ]) {
      const invalid = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, invalidRows);
      expect(() => formatSemanticPlanResult(invalid)).toThrow(SemanticResultFormatError);
    }
  });

  it('distinguishes an empty row result from a scalar zero', async () => {
    const standings = await prepare(STANDINGS);
    const empty = await executeAndFormat(standings, []);
    expect(empty.answer).toEqual({ headline: 'No matching source rows were available.', facts: [] });
    expect(empty.metadata.coverage).toEqual({ status: 'empty', rows_returned: 0, row_limit: 100 });
    expect(empty.metadata.caveats).toEqual(['empty_result_is_not_zero']);

    const norris = span(COMPOSE, 'Norris');
    const composed = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [{
      ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    const execution = await executeSemanticPlanRowsOffline(composed.proof, composed.profile_id, []);
    expect(() => formatSemanticPlanResult(execution)).toThrow('exactly one row');
  });

  it('rejects copied proofs and malformed, partial, unexpected, or integrity-failed rows', async () => {
    const prepared = await prepare(STANDINGS);
    const valid = { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true };
    await expect(executeSemanticPlanRowsOffline({ ...prepared.proof } as never, prepared.profile_id, [valid]))
      .rejects.toThrow('invalid_authorization');
    expect(() => formatSemanticPlanResult(null)).toThrow('provenance');
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
      try {await executeAndFormat(prepared, [row]);} catch (error) {failure = error;}
      expect(failure, name).toBeInstanceOf(Error);
    }
  });

  it('rejects sparse arrays and snapshots descriptor values before validation', async () => {
    const prepared = await prepare(STANDINGS);
    const sparse = new Array(1);
    await expect(executeAndFormat(prepared, sparse)).rejects.toThrow('dense');

    const target = { driver_id: 'lando-norris', points: '357.000', [PLANNED_INTEGRITY_FIELD]: true };
    const proxy = new Proxy(target, {
      get: (_target, property) => property === 'points' ? 'substituted' : Reflect.get(target, property)
    });
    const formatted = await executeAndFormat(prepared, [proxy]);
    expect(formatted.answer.facts[0].values.points).toBe('357');
    expect(formatted.rows[0].points).toBe('357.000');

    const overriddenMap = [target];
    Object.defineProperty(overriddenMap, 'map', {
      value: () => [{ driver_id: 'substituted', points: 357 }]
    });
    expect((await executeAndFormat(prepared, overriddenMap)).answer.facts[0].subject).toBe('lando-norris');
  });

  it('rejects duplicate, tied, misordered, and over-observed row results', async () => {
    const prepared = await prepare(STANDINGS);
    const row = (driver_id: string) => ({ driver_id, points: '1.000', [PLANNED_INTEGRITY_FIELD]: true });
    await expect(executeAndFormat(prepared, [row('a'), row('a')])).rejects.toThrow('duplicate output grain');
    await expect(executeAndFormat(prepared, [row('b'), row('a')])).rejects.toThrow('ordering');
    const observed = Array.from({ length: 101 }, (_, index) => row(`driver-${String(index).padStart(3, '0')}`));
    const truncated = await executeAndFormat(prepared, observed);
    expect(truncated.metadata.coverage).toEqual({ status: 'possibly_truncated', rows_returned: 100, row_limit: 100 });
    expect(truncated.metadata.caveats).toEqual([FINAL_STANDINGS_ROWS_CAVEAT]);

    let accessed = false;
    const rejectedBeforeAccess = new Array(102);
    Object.defineProperty(rejectedBeforeAccess, 0, { get: () => {accessed = true; return row('driver-000');} });
    await expect(executeAndFormat(prepared, rejectedBeforeAccess)).rejects.toThrow('more than 101 rows');
    expect(accessed).toBe(false);

    const atLimit = await executeAndFormat(prepared, observed.slice(0, 100));
    expect(atLimit.metadata.coverage).toEqual({ status: 'sufficient', rows_returned: 100, row_limit: 100 });
    expect(atLimit.metadata.caveats).toEqual([]);
  });

  it('independently rejects invalid positions and incomplete joined metadata', async () => {
    const prepared = await prepare(RACE_METADATA, [], [], { type: 'resolved', season: 2025, round: 1 });
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
      await expect(executeAndFormat(prepared, [{ ...valid, ...mutation }])).rejects.toThrow(SemanticResultFormatError);
    }
  });

  it('rejects negative aggregate counts', async () => {
    const norris = span(COMPOSE, 'Norris');
    const prepared = await prepare(COMPOSE, [{ type: 'driver', span: norris }], [{
      ...norris, candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    await expect(executeAndFormat(prepared, [{
      event_classification__count_finishing_position: -1,
      qualifying_classification__count_qualifying_position: 2,
      [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('nonnegative count');
  });

  it('formats exactly one nullable race date and rejects missing or overfull event evidence', async () => {
    const prepared = await prepare(EVENT_DATE, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [{
      date: new Date(2025, 0, 1), [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      rows: [{ date: '2025-01-01' }],
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'date', direction: 'asc', nulls: 'last' }]
      }
    });
    expect((await executeAndFormat(prepared, [{
      date: null, [PLANNED_INTEGRITY_FIELD]: true
    }])).rows).toEqual([{ date: null }]);
    await expect(executeAndFormat(prepared, [])).rejects.toThrow('exactly one row');
    await expect(executeAndFormat(prepared, [
      { date: '2025-01-01', [PLANNED_INTEGRITY_FIELD]: true },
      { date: '2025-01-02', [PLANNED_INTEGRITY_FIELD]: true }
    ])).rejects.toThrow('collection evidence was incomplete');
    await expect(executeAndFormat(prepared, [{
      date: '2025-02-30', [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('ISO date');
    await expect(executeAndFormat(prepared, [{
      date: '2025-01-01', [PLANNED_INTEGRITY_FIELD]: false
    }])).rejects.toThrow('failed source integrity');
  });

  it('formats exactly one nullable circuit identifier and rejects invalid event evidence', async () => {
    const prepared = await prepare(EVENT_CIRCUIT, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [{
      circuit_id: ' Circuit_ID_01 ', [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      answer: { facts: [{ subject: ' Circuit_ID_01 ', values: {} }] },
      rows: [{ circuit_id: ' Circuit_ID_01 ' }],
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'circuit_id', direction: 'asc', nulls: 'last' }]
      }
    });
    expect((await executeAndFormat(prepared, [{
      circuit_id: null, [PLANNED_INTEGRITY_FIELD]: true
    }]))).toMatchObject({
      answer: { facts: [{ subject: 'result 1', values: { circuit_id: null } }] },
      rows: [{ circuit_id: null }]
    });
    await expect(executeAndFormat(prepared, [])).rejects.toThrow('exactly one row');
    await expect(executeAndFormat(prepared, [
      { circuit_id: 'albert-park', [PLANNED_INTEGRITY_FIELD]: true },
      { circuit_id: 'silverstone', [PLANNED_INTEGRITY_FIELD]: true }
    ])).rejects.toThrow('collection evidence was incomplete');
    await expect(executeAndFormat(prepared, [{
      circuit_id: '   ', [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('nonempty');
    await expect(executeAndFormat(prepared, [{
      circuit_id: 'albert-park', [PLANNED_INTEGRITY_FIELD]: false
    }])).rejects.toThrow('failed source integrity');
  });

  it('formats exactly one nullable event name and preserves nonblank source text', async () => {
    const prepared = await prepare(EVENT_NAME, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [{
      event_name: ' Formula 1 Australian Grand Prix ', [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      answer: { facts: [{ subject: 'result 1', values: { event_name: ' Formula 1 Australian Grand Prix ' } }] },
      rows: [{ event_name: ' Formula 1 Australian Grand Prix ' }],
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'event_name', direction: 'asc', nulls: 'last' }]
      }
    });
    expect((await executeAndFormat(prepared, [{
      event_name: null, [PLANNED_INTEGRITY_FIELD]: true
    }]))).toMatchObject({
      answer: { facts: [{ subject: 'result 1', values: { event_name: null } }] },
      rows: [{ event_name: null }]
    });
    await expect(executeAndFormat(prepared, [])).rejects.toThrow('exactly one row');
    await expect(executeAndFormat(prepared, [
      { event_name: 'Australian Grand Prix', [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: 'Bahrain Grand Prix', [PLANNED_INTEGRITY_FIELD]: true }
    ])).rejects.toThrow('collection evidence was incomplete');
    await expect(executeAndFormat(prepared, [{
      event_name: '   ', [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('nonempty');
    await expect(executeAndFormat(prepared, [{
      event_name: 'Australian Grand Prix', [PLANNED_INTEGRITY_FIELD]: false
    }])).rejects.toThrow('failed source integrity');
  });

  it('formats exactly one canonical nullable event date-and-name pair', async () => {
    const prepared = await prepare(EVENT_NAME_DATE, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [{
      date: new Date(2025, 0, 1),
      event_name: ' Formula 1 Australian Grand Prix ',
      [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(formatted).toMatchObject({
      format_version: 'semantic-result-format-v27',
      answer: {
        facts: [{
          subject: 'result 1',
          values: { date: '2025-01-01', event_name: ' Formula 1 Australian Grand Prix ' }
        }]
      },
      rows: [{ date: '2025-01-01', event_name: ' Formula 1 Australian Grand Prix ' }],
      metadata: {
        coverage: { status: 'sufficient', rows_returned: 1, row_limit: 1 },
        ordering: [{ output_id: 'date', direction: 'asc', nulls: 'last' }]
      }
    });
    expect(Object.keys(formatted.rows[0])).toEqual(['date', 'event_name']);
    for (const row of [
      { date: null, event_name: 'Australian Grand Prix' },
      { date: '2025-01-01', event_name: null },
      { date: null, event_name: null }
    ]) {
      expect((await executeAndFormat(prepared, [{
        ...row, [PLANNED_INTEGRITY_FIELD]: true
      }])).rows).toEqual([row]);
    }
    await expect(executeAndFormat(prepared, [])).rejects.toThrow('exactly one row');
    await expect(executeAndFormat(prepared, [
      { date: '2025-01-01', event_name: 'Australian Grand Prix', [PLANNED_INTEGRITY_FIELD]: true },
      { date: '2025-01-02', event_name: 'Bahrain Grand Prix', [PLANNED_INTEGRITY_FIELD]: true }
    ])).rejects.toThrow('collection evidence was incomplete');
    for (const row of [
      { event_name: 'Australian Grand Prix' },
      { date: '2025-01-01' },
      { date: '2025-01-01', event_name: 'Australian Grand Prix', circuit_id: 'albert-park' },
      { date: '2025-02-30', event_name: 'Australian Grand Prix' },
      { date: '2025-01-01', event_name: '   ' }
    ]) {
      await expect(executeAndFormat(prepared, [{
        ...row, [PLANNED_INTEGRITY_FIELD]: true
      }])).rejects.toThrow(SemanticResultFormatError);
    }
    await expect(executeAndFormat(prepared, [{
      date: '2025-01-01', event_name: 'Australian Grand Prix', [PLANNED_INTEGRITY_FIELD]: false
    }])).rejects.toThrow('failed source integrity');
  });

  it.each([
    [EVENT_DATE_CIRCUIT, ['date', 'circuit_id'], {
      date: new Date(2025, 2, 16), circuit_id: ' albert-park '
    }],
    [EVENT_NAME_CIRCUIT, ['event_name', 'circuit_id'], {
      event_name: ' Formula 1 Australian Grand Prix ', circuit_id: ' albert-park '
    }],
    [EVENT_ALL_METADATA, ['date', 'event_name', 'circuit_id'], {
      date: new Date(2025, 2, 16), event_name: ' Formula 1 Australian Grand Prix ', circuit_id: ' albert-park '
    }]
  ] as const)('strictly formats the complete one-event metadata projection lattice: %s', async (
    question, outputIds, inputRow
  ) => {
    const prepared = await prepare(question, [], [], { type: 'resolved', season: 2025, round: 1 });
    const formatted = await executeAndFormat(prepared, [{
      ...inputRow, [PLANNED_INTEGRITY_FIELD]: true
    }]);
    expect(Object.keys(formatted.rows[0])).toEqual(outputIds);
    expect(formatted.metadata.ordering).toEqual([{
      output_id: outputIds[0], direction: 'asc', nulls: 'last'
    }]);
    expect(formatted.rows[0]).toEqual(Object.fromEntries(outputIds.map(id => [
      id, id === 'date' ? '2025-03-16' : inputRow[id as keyof typeof inputRow]
    ])));

    const nullRow = Object.fromEntries(outputIds.map(id => [id, null]));
    expect((await executeAndFormat(prepared, [{
      ...nullRow, [PLANNED_INTEGRITY_FIELD]: true
    }])).rows).toEqual([nullRow]);
    await expect(executeAndFormat(prepared, [])).rejects.toThrow('exactly one row');
    await expect(executeAndFormat(prepared, [
      { ...inputRow, [PLANNED_INTEGRITY_FIELD]: true },
      { ...inputRow, [PLANNED_INTEGRITY_FIELD]: true }
    ])).rejects.toThrow('collection evidence was incomplete');
    const missing = { ...inputRow } as Record<string, unknown>;
    delete missing[outputIds.at(-1)!];
    await expect(executeAndFormat(prepared, [{
      ...missing, [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('proven schema');
    await expect(executeAndFormat(prepared, [{
      ...inputRow, unexpected: true, [PLANNED_INTEGRITY_FIELD]: true
    }])).rejects.toThrow('proven schema');
    await expect(executeAndFormat(prepared, [{
      ...inputRow, [PLANNED_INTEGRITY_FIELD]: false
    }])).rejects.toThrow('failed source integrity');
  });

  it('keeps database and route work outside the formatter', () => {
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
  const profile_id = plan.topology === 'row_dimension_join'
    ? plan.source_graph.row_relationship_ids.includes('qualifying_event_metadata')
      ? 'semantic-safe-qualifying-dimension-join-v1' as const
      : 'semantic-safe-dimension-join-v1' as const
    : plan.topology === 'scalar_aggregate_compose'
      ? 'semantic-aggregate-locality-v1' as const
      : 'semantic-single-source-v1' as const;
  return { proof, plan, profile_id };
}

async function executeAndFormat(
  prepared: Awaited<ReturnType<typeof prepare>>,
  rows: readonly Record<string, unknown>[]
) {
  const execution = await executeSemanticPlanRowsOffline(prepared.proof, prepared.profile_id, rows);
  return formatSemanticPlanResult(execution);
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}
