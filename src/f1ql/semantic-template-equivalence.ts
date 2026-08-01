import {
  ANSWER_TEMPLATE_IDS,
  AnswerTemplateId,
  validateAnswerTemplateVariables
} from './answer-templates';
import { F1QLProgram } from './ast';
import { normalizeF1QLProgram } from './program-normalization';

export const SEMANTIC_TEMPLATE_EQUIVALENCE_VERSION = 'semantic-template-equivalence-v3' as const;

export type SemanticTemplateEquivalenceStatus = 'partial' | 'unmapped';
export type SemanticTemplateEquivalenceBlocker =
  | 'current_question_language_unmapped'
  | 'filtered_template_domain_unmapped'
  | 'wire_envelope_contract_unmapped'
  | 'template_equivalence_unmapped';

export interface SemanticTemplateEquivalenceEntry {
  readonly status: SemanticTemplateEquivalenceStatus;
  readonly canonical_response_contract: 'equivalent' | 'unmapped';
  readonly response_metadata_mapping: 'accounted' | 'unmapped';
  readonly blockers: readonly SemanticTemplateEquivalenceBlocker[];
  readonly overlap_id?: 'unfiltered_final_standings_points';
}

const unmapped = (): SemanticTemplateEquivalenceEntry => ({
  status: 'unmapped',
  canonical_response_contract: 'unmapped',
  response_metadata_mapping: 'unmapped',
  blockers: ['template_equivalence_unmapped']
});

export const SEMANTIC_TEMPLATE_EQUIVALENCE = deepFreeze({
  current_standings: unmapped(),
  driver_career_official_summary: unmapped(),
  driver_career_qualifying_p1_count: unmapped(),
  driver_career_wins_by_circuit: unmapped(),
  driver_season_official_summary: unmapped(),
  driver_season_qualifying_p1_count: unmapped(),
  driver_season_qualifying_top_ten_count: unmapped(),
  final_standings_driver_ranking: unmapped(),
  final_standings_leader: unmapped(),
  final_standings_points: {
    status: 'partial',
    canonical_response_contract: 'equivalent',
    response_metadata_mapping: 'accounted',
    blockers: [
      'current_question_language_unmapped',
      'filtered_template_domain_unmapped',
      'wire_envelope_contract_unmapped'
    ],
    overlap_id: 'unfiltered_final_standings_points'
  },
  official_driver_results_comparison: unmapped(),
  qualifying_classification_all: unmapped(),
  qualifying_classification_driver: unmapped(),
  qualifying_classification_position: unmapped(),
  qualifying_classification_status: unmapped(),
  qualifying_season_position_h2h: unmapped(),
  race_classification_all: unmapped(),
  race_classification_driver: unmapped(),
  race_classification_position: unmapped(),
  race_classification_status: unmapped(),
  race_date: unmapped(),
  race_event_finishing_position_comparison: unmapped(),
  race_season_finishing_position_h2h: unmapped(),
  season_qualifying_top_ten_ranking: unmapped()
} satisfies Record<AnswerTemplateId, SemanticTemplateEquivalenceEntry>);

export function classifySemanticTemplateEquivalence(
  templateId: AnswerTemplateId,
  variablesInput: unknown,
  programInput: F1QLProgram | undefined
): 'program_shape_overlap' | 'unmapped' {
  const entry = SEMANTIC_TEMPLATE_EQUIVALENCE[templateId];
  if (entry.status !== 'partial') {return 'unmapped';}
  const variables = validateAnswerTemplateVariables(templateId, variablesInput);
  if (templateId !== 'final_standings_points' || variables.driver_ids !== undefined ||
      !Number.isSafeInteger(variables.season) || programInput === undefined) {
    return 'unmapped';
  }
  const season = variables.season as number;
  const expected = normalizeF1QLProgram({
    version: 1,
    root: {
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season } },
      group_by: ['driver_id'],
      measures: [{ as: 'points', function: 'max', field: 'points' }]
    }
  });
  return JSON.stringify(programInput) === JSON.stringify(expected) ? 'program_shape_overlap' : 'unmapped';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
  }
  return value;
}

if (Object.keys(SEMANTIC_TEMPLATE_EQUIVALENCE).sort().join('\n') !== ANSWER_TEMPLATE_IDS.join('\n')) {
  throw new Error('Semantic template equivalence accounting is incomplete');
}
