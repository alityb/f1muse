import { describe, expect, it } from 'vitest';
import { F1QLProgram } from '../../src/f1ql/ast';
import { ANSWER_TEMPLATE_IDS, AnswerTemplateId, materializeAnswerTemplate } from '../../src/f1ql/answer-templates';
import { enumerateSemanticQueries } from '../../src/f1ql/semantic-query';
import {
  classifySemanticTemplateEquivalence,
  SEMANTIC_TEMPLATE_EQUIVALENCE,
  SEMANTIC_TEMPLATE_EQUIVALENCE_VERSION
} from '../../src/f1ql/semantic-template-equivalence';
import { semanticShadowActiveVersions } from '../../src/f1ql/semantic-shadow-planner';
import { answerEvaluationManifest } from '../fixtures/f1ql-answer-evaluation-manifest';

describe('Phase 11 current-template equivalence accounting', () => {
  it('exhaustively accounts for every current template without claiming completion', () => {
    expect(SEMANTIC_TEMPLATE_EQUIVALENCE_VERSION).toBe('semantic-template-equivalence-v1');
    expect(semanticShadowActiveVersions().orchestrator).toBe('semantic-shadow-planner-v2');
    expect(Object.keys(SEMANTIC_TEMPLATE_EQUIVALENCE).sort()).toEqual(ANSWER_TEMPLATE_IDS);
    expect(Object.isFrozen(SEMANTIC_TEMPLATE_EQUIVALENCE)).toBe(true);
    expect(Object.values(SEMANTIC_TEMPLATE_EQUIVALENCE).every(Object.isFrozen)).toBe(true);
    expect(Object.entries(SEMANTIC_TEMPLATE_EQUIVALENCE).filter(([, entry]) => entry.status === 'partial'))
      .toEqual([['final_standings_points', {
        status: 'partial',
        blockers: [
          'current_question_language_unmapped',
          'filtered_template_domain_unmapped',
          'response_contract_unmapped'
        ],
        overlap_id: 'unfiltered_final_standings_points'
      }]]);
    expect(Object.values(SEMANTIC_TEMPLATE_EQUIVALENCE).filter(entry => entry.status === 'unmapped'))
      .toHaveLength(ANSWER_TEMPLATE_IDS.length - 1);
  });

  it('accounts for all 75 cases without claiming any current question is equivalent', () => {
    const answerCases = answerEvaluationManifest.filter(item => item.expected.action === 'answer');
    const programDispositions = answerCases.map(item => ({ id: item.id, disposition: dispositionFor(item) }));
    const caseDispositions = programDispositions.map(item => ({
      id: item.id,
      disposition: item.disposition === 'program_shape_overlap'
        ? 'current_question_language_unmapped'
        : 'template_equivalence_unmapped'
    }));

    expect(answerEvaluationManifest).toHaveLength(110);
    expect(answerCases).toHaveLength(75);
    expect(caseDispositions).toHaveLength(answerCases.length);
    expect(new Set(caseDispositions.map(item => item.id)).size).toBe(answerCases.length);
    expect(programDispositions.filter(item => item.disposition === 'program_shape_overlap').map(item => item.id))
      .toEqual(['dev-points', 'iid-points-all']);
    expect(programDispositions.filter(item => item.disposition === 'unmapped')).toHaveLength(73);
    expect(caseDispositions.every(item => item.disposition.endsWith('_unmapped'))).toBe(true);

    expect(enumerateSemanticQueries(answerCases.find(item => item.id === 'dev-points')!.question))
      .toMatchObject({ type: 'candidate_set', ambiguity_reason: 'metric_ambiguous' });
    expect(enumerateSemanticQueries(answerCases.find(item => item.id === 'iid-points-all')!.question))
      .toMatchObject({ type: 'abstention', reason: 'unknown_language' });
  });

  it('keeps filtered standings and every other template outside the sole partial oracle', () => {
    const unfiltered = materializeAnswerTemplate('final_standings_points', { season: 2025 });
    expect(classifySemanticTemplateEquivalence('final_standings_points', { season: 2025 }, unfiltered))
      .toBe('program_shape_overlap');
    expect(classifySemanticTemplateEquivalence('final_standings_points', {
      season: 2025,
      driver_ids: ['lando-norris']
    }, materializeAnswerTemplate('final_standings_points', {
      season: 2025,
      driver_ids: ['lando-norris']
    }))).toBe('unmapped');
    expect(classifySemanticTemplateEquivalence('final_standings_points', { season: 2025 }, {
      ...unfiltered,
      root: { ...unfiltered.root, measures: [{ as: 'points', function: 'min', field: 'points' }] }
    } as F1QLProgram)).toBe('unmapped');
    for (const templateId of ANSWER_TEMPLATE_IDS.filter(id => id !== 'final_standings_points')) {
      expect(classifySemanticTemplateEquivalence(templateId, undefined, undefined), templateId).toBe('unmapped');
    }
  });
});

function dispositionFor(item: typeof answerEvaluationManifest[number]): 'program_shape_overlap' | 'unmapped' {
  const templateId = item.expected.template_id;
  const programs = item.expected.acceptable_programs;
  if (!templateId || !programs || programs.length !== 1) {
    throw new Error(`Answer case ${item.id} lacks one exact template program`);
  }
  if (SEMANTIC_TEMPLATE_EQUIVALENCE[templateId].status !== 'partial') {return 'unmapped';}
  return classifySemanticTemplateEquivalence(
    templateId,
    finalStandingsVariables(templateId, programs[0]),
    programs[0]
  );
}

function finalStandingsVariables(templateId: AnswerTemplateId, program: F1QLProgram): unknown {
  if (templateId !== 'final_standings_points' || program.root.op !== 'aggregate' ||
      program.root.input.op !== 'filter' || program.root.input.input.op !== 'source' ||
      program.root.input.input.source !== 'standings' || program.version !== 1 ||
      program.root.group_by.length !== 1 || program.root.group_by[0] !== 'driver_id' ||
      program.root.measures.length !== 1 || program.root.measures[0].as !== 'points' ||
      program.root.measures[0].function !== 'max' || program.root.measures[0].field !== 'points') {
    throw new Error('Partial template case does not have the reviewed final standings shape');
  }
  const where = program.root.input.where;
  return {
    season: where.season,
    ...(where.driver_id === undefined ? {} : { driver_ids: where.driver_id })
  };
}
