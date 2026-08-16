import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { enforceAnswerRows, enforceAnswerWorkBudget, serializeAnswerResponse } from '../src/f1ql/answer-bounds';
import { buildAnswerEnvelope } from '../src/f1ql/answer-format';
import { authorizeAnswerProgram } from '../src/f1ql/answer-policy';
import { executeF1QL } from '../src/f1ql/executor';
import { AnswerTemplateId, materializeAnswerTemplate } from '../src/f1ql/answer-templates';
import { F1QLProgram } from '../src/f1ql/ast';
import { getF1QLProgramHash } from '../src/f1ql/verified-programs';
import { getTestDatabaseUrl, setupTestDatabase } from '../src/test/setup';
import { seedAnswerEvaluationFixture } from '../tests/fixtures/f1ql-answer-evaluation-fixture';
import { answerEvaluationManifest } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

export async function emitAnswerEvaluationResults(pool: Pool) {
  const emitted = [];
  for (const item of answerEvaluationManifest.filter(testCase => testCase.expected.action === 'answer')) {
    const reviewedProgram = item.expected.acceptable_programs?.[0];
    if (!reviewedProgram || !item.expected.template_id) throw new Error(`missing reviewed template for ${item.id}`);
    const program = materializeAnswerTemplate(item.expected.template_id, templateVariables(item.expected.template_id, reviewedProgram));
    if (getF1QLProgramHash(program) !== getF1QLProgramHash(reviewedProgram)) throw new Error(`reviewed template mismatch for ${item.id}`);
    const decision = authorizeAnswerProgram(program);
    if (decision.type !== 'approved') throw new Error(`reviewed program denied for ${item.id}`);
    enforceAnswerWorkBudget(program, decision.capability, 2_280, 100);
    const result = await executeF1QL(pool, program, { statementTimeoutMs: 1000, maxRows: 100 });
    enforceAnswerRows(result.rows, 100);
    const envelope = buildAnswerEnvelope(result.program, decision.capability, result.rows);
    serializeAnswerResponse(envelope, 65_536);
    emitted.push({ id: item.id, envelope });
  }
  return emitted;
}

function templateVariables(templateId: AnswerTemplateId, program: F1QLProgram): Record<string, unknown> {
  const root = program.root;
  if ((templateId === 'final_standings' || templateId === 'final_standings_leader' || templateId === 'current_standings') && root.op === 'rank' && root.input.input.op === 'filter') {
    return { season: root.input.input.where.season };
  }
  if (templateId === 'final_standings_driver_ranking' && root.op === 'rank' && root.input.input.op === 'filter' && Array.isArray(root.input.input.where.driver_id)) {
    return { season: root.input.input.where.season, driver_ids: root.input.input.where.driver_id };
  }
  if (templateId === 'final_standings_points' && root.op === 'aggregate' && root.input.op === 'filter') {
    const drivers = root.input.where.driver_id;
    return { season: root.input.where.season, ...(drivers ? { driver_ids: Array.isArray(drivers) ? drivers : [drivers] } : {}) };
  }
  if (templateId === 'driver_season_official_summary' && root.op === 'aggregate' && root.input.op === 'filter' && typeof root.input.where.driver_id === 'string') {
    return { season: root.input.where.season, driver_id: root.input.where.driver_id };
  }
  if (templateId === 'driver_career_official_summary' && root.op === 'aggregate' && root.input.op === 'filter' && typeof root.input.where.driver_id === 'string') {
    return { driver_id: root.input.where.driver_id };
  }
  if (templateId === 'driver_career_wins_by_circuit' && root.op === 'driver_career_wins_by_circuit') {
    return { driver_id: root.driver_id };
  }
  if ((templateId === 'race_season_finishing_position_h2h' && root.op === 'race_season_finishing_position_h2h') ||
      (templateId === 'qualifying_season_position_h2h' && root.op === 'qualifying_season_position_h2h')) {
    return { season: root.season, driver_a_id: root.driver_a_id, driver_b_id: root.driver_b_id };
  }
  if (templateId === 'official_driver_results_comparison' && root.op === 'official_driver_results_comparison') {
    return { season: root.season, driver_a_id: root.driver_a_id, driver_b_id: root.driver_b_id };
  }
  if (templateId === 'race_event_finishing_position_comparison' && root.op === 'race_event_finishing_position_comparison') {
    return { season: root.season, round: root.round, driver_a_id: root.driver_a_id, driver_b_id: root.driver_b_id };
  }
  if ((templateId === 'driver_season_qualifying_p1_count' && root.op === 'driver_season_qualifying_p1_count') ||
      (templateId === 'driver_season_qualifying_top_ten_count' && root.op === 'driver_season_qualifying_top_ten_count')) {
    return { season: root.season, driver_id: root.driver_id };
  }
  if (templateId === 'driver_career_qualifying_p1_count' && root.op === 'driver_career_qualifying_p1_count') {
    return { driver_id: root.driver_id };
  }
  if (templateId === 'season_qualifying_top_ten_ranking' && root.op === 'season_qualifying_top_ten_ranking') {
    return { season: root.season };
  }
  if (templateId === 'race_date' && root.op === 'event_metadata') {
    return { season: root.season, round: root.round };
  }
  if ((root.op === 'event_classification' || root.op === 'qualifying_classification') && root.filters?.driver_id) {
    return { season: root.season, round: root.round, driver_id: root.filters.driver_id };
  }
  if ((root.op === 'event_classification' || root.op === 'qualifying_classification') && root.filters?.classification_status) {
    return { season: root.season, round: root.round, status: root.filters.classification_status[0] };
  }
  if (templateId === 'race_classification_position' && root.op === 'event_classification' && root.filters?.finishing_position) {
    return { season: root.season, round: root.round, positions: root.filters.finishing_position };
  }
  if (templateId === 'qualifying_classification_position' && root.op === 'qualifying_classification' && root.filters?.qualifying_position) {
    return { season: root.season, round: root.round, positions: root.filters.qualifying_position };
  }
  if (root.op === 'event_classification' || root.op === 'qualifying_classification') {
    return { season: root.season, round: root.round };
  }
  throw new Error(`reviewed program does not match ${templateId}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getTestDatabaseUrl() });
  try {
    await setupTestDatabase(pool, { seed: false });
    await seedAnswerEvaluationFixture(pool);
    const emitted = await emitAnswerEvaluationResults(pool);
    writeFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', `${JSON.stringify(emitted, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main();
