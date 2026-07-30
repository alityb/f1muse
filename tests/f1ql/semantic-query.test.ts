import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admitSemanticQueryCandidates,
  computeSemanticCandidateSetHash,
  computeSemanticQueryHash,
  enumerateSemanticQueries,
  parseSemanticQueryCandidateSet,
  SemanticEvidence,
  SemanticLiteralSpan,
  SemanticQuery,
  verifySemanticQueryAdmission
} from '../../src/f1ql/semantic-query';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';

const STANDINGS_QUESTION = 'List driver and championship points from final 2025 driver standings.';
const RACE_QUESTION = 'List driver and finishing position for round 1 of the final 2025 race classification.';
const QUALIFYING_RANK_QUESTION = 'Show top 10 drivers by count of qualifying position in final 2025 qualifying classification.';
const RACE_METADATA_QUESTION = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const RACE_QUALIFYING_COUNT_QUESTION = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';

describe('semantic query candidates and independent evidence', () => {
  it('enumerates one catalog-bound explicit standings query and freezes all evidence', () => {
    const evidence = candidateEvidence(STANDINGS_QUESTION);
    expect(evidence.catalog_hash).toBe(SEMANTIC_CATALOG_HASH);
    expect(evidence.candidates).toHaveLength(1);
    expect(evidence.candidates[0]).toMatchObject({
      version: 2,
      outputs: [
        { kind: 'concept', concept: { source_id: 'driver_standings', concept_id: 'driver_id' } },
        { kind: 'concept', concept: { source_id: 'driver_standings', concept_id: 'points' } }
      ],
      scopes: expect.arrayContaining([
        { kind: 'season', value: 2025, evidence: [span(STANDINGS_QUESTION, '2025')] },
        expect.objectContaining({ kind: 'session', source_id: 'driver_standings', value: 'season', evidence: expect.any(Array) }),
        { kind: 'temporal', value: 'final', evidence: [span(STANDINGS_QUESTION, 'final')] }
      ]),
      entities: [],
      filters: [],
      group_by: [],
      order_by: []
    });
    expect(evidence.candidate_set_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.candidates[0].outputs)).toBe(true);
  });

  it('enumerates explicit row scope and aggregate ranking semantics', () => {
    const race = candidateEvidence(RACE_QUESTION).candidates[0];
    expect(race.scopes).toEqual(expect.arrayContaining([
      { kind: 'round', value: 1, evidence: [span(RACE_QUESTION, '1')] },
      expect.objectContaining({ kind: 'session', source_id: 'event_classification', value: 'race', evidence: expect.any(Array) })
    ]));

    const ranking = candidateEvidence(QUALIFYING_RANK_QUESTION).candidates[0];
    expect(ranking.outputs).toEqual([
      expect.objectContaining({ kind: 'concept', concept: { source_id: 'qualifying_classification', concept_id: 'driver_id' } }),
      expect.objectContaining({ kind: 'aggregate', function: 'count', concept: { source_id: 'qualifying_classification', concept_id: 'qualifying_position' } })
    ]);
    expect(ranking.group_by).toEqual([
      expect.objectContaining({ concept: { source_id: 'qualifying_classification', concept_id: 'driver_id' } })
    ]);
    expect(ranking.comparison).toMatchObject({ relation: 'rank' });
    expect(ranking.order_by).toEqual([expect.objectContaining({ output_index: 1, direction: 'desc' })]);
    expect(ranking.limit).toMatchObject({ value: 10 });
  });

  it('enumerates only the promoted row join and aggregate-local scalar composition', () => {
    const rowJoin = candidateEvidence(RACE_METADATA_QUESTION).candidates[0];
    expect([...new Set(rowJoin.outputs.map(output => output.concept.source_id))]).toEqual([
      'event_classification', 'event_metadata'
    ]);
    expect(rowJoin.scopes.filter(scope => scope.kind === 'session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: 'event_classification', value: 'race' }),
      expect.objectContaining({ source_id: 'event_metadata', value: 'race' })
    ]));

    const norris = { type: 'driver', span: span(RACE_QUALIFYING_COUNT_QUESTION, 'Norris') };
    const aggregate = candidateEvidence(RACE_QUALIFYING_COUNT_QUESTION, [norris]).candidates[0];
    expect(aggregate.outputs).toEqual([
      expect.objectContaining({ kind: 'aggregate', function: 'count', concept: { source_id: 'event_classification', concept_id: 'finishing_position' } }),
      expect.objectContaining({ kind: 'aggregate', function: 'count', concept: { source_id: 'qualifying_classification', concept_id: 'qualifying_position' } })
    ]);
    expect(aggregate.scopes.filter(scope => scope.kind === 'session')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_id: 'event_classification', value: 'race' }),
      expect.objectContaining({ source_id: 'qualifying_classification', value: 'qualifying' })
    ]));
    expect(aggregate.filters).toEqual([
      expect.objectContaining({ concept: { source_id: 'event_classification', concept_id: 'driver_id' }, entity_indices: [0] }),
      expect.objectContaining({ concept: { source_id: 'qualifying_classification', concept_id: 'driver_id' }, entity_indices: [0] })
    ]);
  });

  it('fails closed on every unpromoted explicit source combination', () => {
    expect(enumerateSemanticQueries('List championship points and finishing position from final 2025 driver standings and race classification.')).toMatchObject({
      type: 'abstention', reason: 'unsupported_source_combination'
    });
    expect(enumerateSemanticQueries('List finishing position and qualifying position from final 2025 race classification and qualifying classification.')).toMatchObject({
      type: 'abstention', reason: 'unsupported_source_combination'
    });
    expect(enumerateSemanticQueries('List championship points and event name for round 1 of final 2025 race classification and event metadata.')).toMatchObject({
      type: 'abstention', reason: 'unsupported_source_combination'
    });
  });

  it('does not collapse multi-source entity attachment or entity-type ambiguity', () => {
    const attached = 'Show count of finishing position for Norris from race classification and count of qualifying position for Piastri from qualifying classification in final 2025.';
    const attachedEvidence = enumerateSemanticQueries(attached, [
      { type: 'driver', span: span(attached, 'Norris') },
      { type: 'driver', span: span(attached, 'Piastri') }
    ]);
    expect(attachedEvidence).toMatchObject({ type: 'candidate_set', ambiguity_reason: 'attachment_ambiguous' });
    if (attachedEvidence.type !== 'candidate_set') throw new Error('missing attachment candidates');
    const attachedAlternative = structuredClone(attachedEvidence.candidates[0]);
    attachedAlternative.filters = attachedAlternative.filters.map((filter, index) => filter.kind === 'entity'
      ? { ...filter, operator: 'eq', entity_indices: [index], evidence: [attachedAlternative.entities[index].span] }
      : filter);
    expect(admitSemanticQueryCandidates({ version: 2, candidates: [attachedAlternative] }, attached, attachedEvidence)).toMatchObject({
      type: 'clarification_required', reason: 'attachment_ambiguous'
    });

    const ambiguous = 'List finishing position and event name from final 2025 race classification and event metadata at Monaco.';
    const monaco = span(ambiguous, 'Monaco');
    const entityEvidence = enumerateSemanticQueries(ambiguous, [
      { type: 'driver', span: monaco },
      { type: 'event', span: monaco }
    ]);
    expect(entityEvidence).toMatchObject({ type: 'candidate_set', ambiguity_reason: 'entity_ambiguous' });
    if (entityEvidence.type !== 'candidate_set') throw new Error('missing entity candidates');
    expect(admitSemanticQueryCandidates({ version: 2, candidates: entityEvidence.candidates }, ambiguous, entityEvidence)).toMatchObject({
      type: 'clarification_required', reason: 'entity_ambiguous'
    });

    expect(enumerateSemanticQueries('Show count of race classification status from race classification and count of qualifying position from qualifying classification in final 2025.')).toMatchObject({
      type: 'abstention', reason: 'unsupported_source_combination'
    });
  });

  it('retains multi-source scope, event, and output alternatives for clarification', () => {
    const events = 'List driver and finishing position and event name from final 2025 race classification and event metadata at Monaco or Silverstone.';
    const eventEvidence = candidateEvidence(events, [
      { type: 'event', span: span(events, 'Monaco') },
      { type: 'event', span: span(events, 'Silverstone') }
    ]);
    expect(eventEvidence).toMatchObject({ ambiguity_reason: 'attachment_ambiguous' });
    expect(eventEvidence.candidates).toHaveLength(2);

    const years = 'List driver and finishing position and event name for round 1 of final 2024 or 2025 race classification and event metadata.';
    const yearEvidence = candidateEvidence(years);
    expect(yearEvidence).toMatchObject({ ambiguity_reason: 'scope_ambiguous' });
    expect(yearEvidence.candidates).toHaveLength(2);

    const outputs = 'List driver and finishing position or event name for round 1 of final 2025 race classification and event metadata.';
    const outputEvidence = candidateEvidence(outputs);
    expect(outputEvidence).toMatchObject({ ambiguity_reason: 'output_shape_ambiguous' });
    const outputAlternative = structuredClone(outputEvidence.candidates[0]);
    outputAlternative.outputs = outputAlternative.outputs.filter(output => output.concept.concept_id !== 'finishing_position');
    expect(admitSemanticQueryCandidates({ version: 2, candidates: [outputAlternative] }, outputs, outputEvidence)).toMatchObject({
      type: 'clarification_required', reason: 'output_shape_ambiguous'
    });
  });

  it('retains metric, output-shape, scope, attachment, and entity ambiguity', () => {
    expect(candidateEvidence('List position for final 2025.')).toMatchObject({
      ambiguity_reason: 'metric_ambiguous',
      candidates: expect.arrayContaining([
        expect.objectContaining({ outputs: [expect.objectContaining({ concept: { source_id: 'driver_standings', concept_id: 'championship_position' } })] }),
        expect.objectContaining({ outputs: [expect.objectContaining({ concept: { source_id: 'event_classification', concept_id: 'finishing_position' } })] }),
        expect.objectContaining({ outputs: [expect.objectContaining({ concept: { source_id: 'qualifying_classification', concept_id: 'qualifying_position' } })] })
      ])
    });
    expect(candidateEvidence('Show final 2025 driver standings.')).toMatchObject({ ambiguity_reason: 'output_shape_ambiguous', candidates: expect.any(Array) });
    const outputAlternativeQuestion = 'List driver and championship points or championship position from final 2025 driver standings.';
    const outputAlternatives = candidateEvidence(outputAlternativeQuestion);
    expect(outputAlternatives).toMatchObject({ ambiguity_reason: 'output_shape_ambiguous' });
    expect(outputAlternatives.candidates.map(candidate => candidate.outputs.map(output => output.concept.concept_id))).toEqual(expect.arrayContaining([
      ['driver_id', 'points'],
      ['driver_id', 'championship_position']
    ]));
    expect(admitSemanticQueryCandidates({ version: 2, candidates: [outputAlternatives.candidates[0]] }, outputAlternativeQuestion, outputAlternatives)).toMatchObject({
      type: 'clarification_required', reason: 'output_shape_ambiguous'
    });
    expect(candidateEvidence('List championship points from final 2024 or 2025 driver standings.')).toMatchObject({ ambiguity_reason: 'scope_ambiguous', candidates: expect.any(Array) });

    const eventQuestion = 'List driver and finishing position for final 2025 race classification at Monaco or Silverstone.';
    expect(candidateEvidence(eventQuestion, [
      { type: 'event', span: span(eventQuestion, 'Monaco') },
      { type: 'event', span: span(eventQuestion, 'Silverstone') }
    ])).toMatchObject({ ambiguity_reason: 'attachment_ambiguous', candidates: expect.any(Array) });

    const entityQuestion = 'List driver and finishing position for final 2025 race classification at Monaco.';
    const monaco = span(entityQuestion, 'Monaco');
    expect(candidateEvidence(entityQuestion, [
      { type: 'driver', span: monaco },
      { type: 'event', span: monaco }
    ])).toMatchObject({ ambiguity_reason: 'entity_ambiguous', candidates: expect.any(Array) });
  });

  it('abstains on unknown language, unsupported comparisons, missing scope, and candidate overflow', () => {
    expect(enumerateSemanticQueries('List secret championship points from final 2025 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unknown_language' });
    expect(enumerateSemanticQueries('Compare finishing position for final 2025 race classification.')).toMatchObject({ type: 'abstention', reason: 'unsupported_comparison' });
    expect(enumerateSemanticQueries('List championship points from final driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List championship points from current 2025 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List championship points from final latest recorded 2025 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List championship points from final 2027 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List championship points from final 2025 or 2027 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List championship points from current 2025 or 2026 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List drivers by championship points from final 2025 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_comparison' });
    expect(enumerateSemanticQueries('Rank drivers by championship points and championship position from final 2025 driver standings.')).toMatchObject({ type: 'abstention', reason: 'unsupported_comparison' });
    expect(enumerateSemanticQueries('List drivers by count of qualifying position from final 2025 qualifying classification.')).toMatchObject({ type: 'abstention', reason: 'unsupported_comparison' });
    expect(enumerateSemanticQueries('Show top 101 drivers by count of qualifying position in final 2025 qualifying classification.')).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
    expect(enumerateSemanticQueries('List position for final 2024 or 2025.')).toMatchObject({
      type: 'abstention', reason: 'candidate_overflow', candidate_count_lower_bound: 6
    });
  });

  it('keeps provider omission from collapsing independent ambiguity', () => {
    const evidence = candidateEvidence('List position for final 2025.');
    const provider = { version: 2, candidates: [evidence.candidates[0]] };
    expect(admitSemanticQueryCandidates(provider, 'List position for final 2025.', evidence)).toEqual({
      type: 'clarification_required',
      reason: 'metric_ambiguous',
      candidate_set_hash: evidence.candidate_set_hash
    });
  });

  it('admits only an equivalent independently enumerated singleton', () => {
    const evidence = candidateEvidence(STANDINGS_QUESTION);
    const provider = { version: 2, candidates: [evidence.candidates[0]] };
    const admission = admitSemanticQueryCandidates(provider, STANDINGS_QUESTION, evidence);
    expect(admission).toMatchObject({
      type: 'admitted',
      query_hash: computeSemanticQueryHash(evidence.candidates[0]),
      candidate_set_hash: evidence.candidate_set_hash
    });
    expect(verifySemanticQueryAdmission(admission, STANDINGS_QUESTION)).toBe(admission);
    expect(() => verifySemanticQueryAdmission({ ...admission }, STANDINGS_QUESTION)).toThrow('provenance');
    expect(() => verifySemanticQueryAdmission(admission, `🏁 ${STANDINGS_QUESTION}`)).toThrow('binding');

    const wrong = structuredClone(evidence.candidates[0]);
    wrong.outputs[1].concept.concept_id = 'championship_position';
    expect(admitSemanticQueryCandidates({ version: 2, candidates: [wrong] }, STANDINGS_QUESTION, evidence)).toEqual({
      type: 'abstention', reason: 'provider_candidate_not_enumerated'
    });
  });

  it('requires active evidence bound to the exact question, catalog, and candidate-set hash', () => {
    const evidence = candidateEvidence(STANDINGS_QUESTION);
    const provider = { version: 2, candidates: [evidence.candidates[0]] };
    expect(() => admitSemanticQueryCandidates(provider, STANDINGS_QUESTION, structuredClone(evidence))).toThrow('not active');
    expect(() => admitSemanticQueryCandidates(provider, `🏁 ${STANDINGS_QUESTION}`, evidence)).toThrow('not active');
  });

  it('does not suppress conflicting concepts, incompatible entity readings, or metric attachments', () => {
    const conflictQuestion = 'List driver and championship points and race points from final 2025 driver standings.';
    expect(candidateEvidence(conflictQuestion)).toMatchObject({ ambiguity_reason: 'metric_ambiguous', candidates: expect.any(Array) });

    const entityQuestion = 'List championship points from final 2025 driver standings for Monaco.';
    const monaco = span(entityQuestion, 'Monaco');
    const entityEvidence = candidateEvidence(entityQuestion, [
      { type: 'driver', span: monaco },
      { type: 'event', span: monaco }
    ]);
    expect(entityEvidence).toMatchObject({ ambiguity_reason: 'entity_ambiguous', candidates: expect.any(Array) });
    expect(admitSemanticQueryCandidates({ version: 2, candidates: entityEvidence.candidates }, entityQuestion, entityEvidence)).toMatchObject({
      type: 'clarification_required', reason: 'entity_ambiguous'
    });

    const attachmentQuestion = 'List Norris championship points and Piastri championship position from final 2025 driver standings.';
    expect(enumerateSemanticQueries(attachmentQuestion, [
      { type: 'driver', span: span(attachmentQuestion, 'Norris') },
      { type: 'driver', span: span(attachmentQuestion, 'Piastri') }
    ])).toMatchObject({ type: 'abstention', reason: 'unsupported_concept' });

    const mixedAttachment = 'List Norris qualifying status and Piastri best qualifying time from final 2025 qualifying classification.';
    expect(enumerateSemanticQueries(mixedAttachment, [
      { type: 'driver', span: span(mixedAttachment, 'Norris') },
      { type: 'driver', span: span(mixedAttachment, 'Piastri') }
    ])).toMatchObject({ type: 'abstention', reason: 'unsupported_concept' });

    const globalQuestion = 'List championship position and championship points for Norris and Piastri from final 2025 driver standings.';
    expect(candidateEvidence(globalQuestion, [
      { type: 'driver', span: span(globalQuestion, 'Norris') },
      { type: 'driver', span: span(globalQuestion, 'Piastri') }
    ]).candidates[0].filters).toEqual([expect.objectContaining({ kind: 'entity', operator: 'in', entity_indices: [0, 1] })]);
  });

  it('fails closed rather than pruning combined or partially unsupported explicit scopes', () => {
    const question = 'List driver and finishing position for round 1 of final 2025 race classification at Monaco.';
    expect(enumerateSemanticQueries(question, [{ type: 'event', span: span(question, 'Monaco') }])).toMatchObject({
      type: 'abstention', reason: 'unsupported_scope'
    });

    const contextual = 'List position for final 2025 at Monaco.';
    const contextualEvidence = candidateEvidence(contextual, [{ type: 'event', span: span(contextual, 'Monaco') }]);
    expect(contextualEvidence).toMatchObject({ ambiguity_reason: 'metric_ambiguous' });
    expect(contextualEvidence.candidates.map(candidate => candidate.outputs[0].concept.source_id)).toEqual([
      'event_classification', 'qualifying_classification'
    ]);
  });

  it('strictly parses one to five declarative candidates and rejects forbidden fields', () => {
    const evidence = candidateEvidence(STANDINGS_QUESTION);
    const candidate = evidence.candidates[0];
    expect(parseSemanticQueryCandidateSet({ version: 2, candidates: [candidate] }, STANDINGS_QUESTION).candidates).toEqual([candidate]);
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [] }, STANDINGS_QUESTION)).toThrow();
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: Array(6).fill(candidate) }, STANDINGS_QUESTION)).toThrow();
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [{ ...candidate, sql: 'SELECT 1' }] }, STANDINGS_QUESTION)).toThrow();
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [{
      ...candidate,
      outputs: [{ ...candidate.outputs[0], concept: { ...candidate.outputs[0].concept, table: 'driver' } }, ...candidate.outputs.slice(1)]
    }] }, STANDINGS_QUESTION)).toThrow();
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [{
      ...candidate,
      entities: [{ type: 'driver', span: span(STANDINGS_QUESTION, 'driver'), driver_id: 'norris' }]
    }] }, STANDINGS_QUESTION)).toThrow();
  });

  it('validates typed filters, catalog concepts, references, and duplicate candidates', () => {
    const candidate = structuredClone(candidateEvidence(RACE_QUESTION).candidates[0]);
    candidate.filters = [{
      kind: 'literal',
      concept: { source_id: 'event_classification', concept_id: 'finishing_position' },
      operator: 'eq',
      value: 1,
      evidence: [span(RACE_QUESTION, '1')]
    }];
    expect(parseSemanticQueryCandidateSet({ version: 2, candidates: [candidate] }, RACE_QUESTION).candidates[0].filters).toHaveLength(1);
    const invalidType = structuredClone(candidate);
    invalidType.filters[0] = { ...invalidType.filters[0], value: 'first' } as typeof invalidType.filters[0];
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [invalidType] }, RACE_QUESTION)).toThrow('does not match');
    const unknownConcept = structuredClone(candidate);
    unknownConcept.outputs[0].concept.concept_id = 'missing_concept';
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [unknownConcept] }, RACE_QUESTION)).toThrow('unknown concept');
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [candidate, candidate] }, RACE_QUESTION)).toThrow('duplicate normalized queries');

    const identityLiteral = structuredClone(candidate);
    identityLiteral.filters = [{
      kind: 'literal',
      concept: { source_id: 'event_classification', concept_id: 'driver_id' },
      operator: 'eq',
      value: 'driver',
      evidence: [span(RACE_QUESTION, 'driver')]
    }];
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [identityLiteral] }, RACE_QUESTION)).toThrow('deterministic entity linking');

    const ungroundedLiteral = structuredClone(candidate);
    ungroundedLiteral.filters[0] = { ...ungroundedLiteral.filters[0], value: 2 } as typeof ungroundedLiteral.filters[0];
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [ungroundedLiteral] }, RACE_QUESTION)).toThrow('not grounded');

    const standings = structuredClone(candidateEvidence(STANDINGS_QUESTION).candidates[0]);
    const temporal = standings.scopes.find(scope => scope.kind === 'temporal')!;
    if (temporal.kind !== 'temporal') throw new Error('missing temporal scope');
    temporal.value = 'latest_recorded';
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [standings] }, STANDINGS_QUESTION)).toThrow('latest-recorded');

    const currentQuestion = 'List championship points from current 2026 driver standings.';
    const forgedQuestion = 'List championship points from current 2025 driver standings.';
    const forgedTemporal = structuredClone(candidateEvidence(currentQuestion).candidates[0]);
    const seasonScope = forgedTemporal.scopes.find(scope => scope.kind === 'season')!;
    const temporalScope = forgedTemporal.scopes.find(scope => scope.kind === 'temporal')!;
    if (seasonScope.kind !== 'season' || temporalScope.kind !== 'temporal') throw new Error('missing semantic scopes');
    seasonScope.value = 2025;
    seasonScope.evidence = [span(forgedQuestion, '2025')];
    temporalScope.value = 'final';
    temporalScope.evidence = [span(forgedQuestion, '2025')];
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [forgedTemporal] }, forgedQuestion)).toThrow('temporal value is not grounded');
  });

  it('uses exact Unicode-code-point spans and rejects UTF-16-style or forged references', () => {
    const question = `🏁 ${STANDINGS_QUESTION}`;
    const evidence = candidateEvidence(question);
    expect(evidence.candidates[0].outputs[0].evidence[0]).toEqual(span(question, 'driver'));
    const forged = structuredClone(evidence.candidates[0]);
    forged.outputs[0].evidence[0].start += 1;
    forged.outputs[0].evidence[0].end += 1;
    expect(() => parseSemanticQueryCandidateSet({ version: 2, candidates: [forged] }, question)).toThrow('does not exactly match');
  });

  it('normalizes provider candidate order without changing candidate-set identity', () => {
    const question = 'List position for final 2025.';
    const evidence = candidateEvidence(question);
    const parsed = parseSemanticQueryCandidateSet({ version: 2, candidates: [...evidence.candidates].reverse() }, question);
    expect(parsed.candidates.map(computeSemanticQueryHash)).toEqual(evidence.candidates.map(computeSemanticQueryHash));
    expect(computeSemanticCandidateSetHash([...evidence.candidates].reverse(), evidence.question_sha256, evidence.catalog_hash, evidence.ambiguity_reason)).toBe(evidence.candidate_set_hash);
    const reordered = structuredClone(evidence.candidates[0]);
    reordered.scopes.reverse();
    expect(computeSemanticQueryHash(reordered)).toBe(computeSemanticQueryHash(evidence.candidates[0]));

    const globalQuestion = 'List championship points for Norris and Piastri from final 2025 driver standings.';
    const global = candidateEvidence(globalQuestion, [
      { type: 'driver', span: span(globalQuestion, 'Norris') },
      { type: 'driver', span: span(globalQuestion, 'Piastri') }
    ]).candidates[0];
    const noncanonical = structuredClone(global);
    noncanonical.entities.reverse();
    expect(() => computeSemanticQueryHash(noncanonical)).toThrow('canonically ordered');
  });

  it('has no reachable planner, Core, database, provider, compiler, formatter, route, or executor import', () => {
    const reachable = reachableLocalModules(path.resolve(process.cwd(), 'src/f1ql/semantic-query.ts'));
    const forbidden = ['compiler.ts', 'core.ts', 'executor.ts', 'planned-f1ql.ts', 'planned-pipeline.ts', 'planned-compiler.ts', 'planned-interpreter.ts', 'answer-format.ts', 'translator.ts'];
    expect([...reachable].filter(file => forbidden.includes(path.basename(file)))).toEqual([]);
    for (const file of reachable) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/(?:from|require\s*\()\s*['"](?:pg|express|redis|@anthropic-ai\/sdk)['"]/u);
    }
  });
});

function candidateEvidence(question: string, entities: readonly unknown[] = []): Extract<SemanticEvidence, { type: 'candidate_set' }> {
  const evidence = enumerateSemanticQueries(question, entities);
  expect(evidence.type).toBe('candidate_set');
  return evidence as Extract<SemanticEvidence, { type: 'candidate_set' }>;
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}

function reachableLocalModules(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gu),
    ...source.matchAll(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)
  ].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
  for (const specifier of imports) {
    const base = path.resolve(path.dirname(entry), specifier);
    const resolved = path.extname(base) ? base : `${base}.ts`;
    reachableLocalModules(resolved, seen);
  }
  return seen;
}
