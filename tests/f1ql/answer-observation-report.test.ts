import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAnswerObservationReport } from '../../src/f1ql/answer-observation-report';
import { reportAnswerObservationFile } from '../../scripts/report-answer-evaluation-observations';
import { canonicalProgramEntities, getAnswerEvaluationManifestHash, validateAnswerObservationArtifact } from '../../src/f1ql/answer-observations';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const artifactHash = 'a'.repeat(64);

function perfectArtifact() {
  return validateAnswerObservationArtifact(answerEvaluationManifest, {
    version: 1,
    kind: 'f1ql_answer_observations',
    provider: { type: 'openai-compatible', model: 'private-model-name', collected_at: '2026-07-24T00:00:00.000Z' },
    manifest: { case_count: answerEvaluationManifest.length, sha256: getAnswerEvaluationManifestHash(answerEvaluationManifest) },
    observations: answerEvaluationManifest.map(item => {
      const program = item.expected.action === 'answer' ? item.expected.acceptable_programs![0] : undefined;
      const entities = program ? canonicalProgramEntities(program) : [...item.canonical_entities].sort();
      const linkedEntities = item.acceptable_linked_entities?.[0] ?? [];
      return program
        ? { id: item.id, action: 'answer', reason: item.expected.reason, program, entity_candidates: entities, linked_entities: entities }
        : { id: item.id, action: item.expected.action, reason: item.expected.reason, entity_candidates: entities, linked_entities: linkedEntities };
    })
  });
}

describe('answer observation reporting', () => {
  it('emits sanitized aggregate thresholds for every required source and operation', () => {
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, perfectArtifact(), artifactHash);
    expect(report.artifact).toMatchObject({ sha256: artifactHash, provider: 'openai-compatible' });
    expect(report.artifact).not.toHaveProperty('model_sha256');
    expect(report.selection).toMatchObject({ observations_missing: 0, unsafe_answers: 0 });
    expect(report.holdout_thresholds.by_source.final_driver_standings.status).toBe('pass');
    expect(report.holdout_thresholds.by_operation.aggregate.status).toBe('pass');
    expect(report.holdout_thresholds.by_operation.rank.status).toBe('pass');
    expect(report.release_gates).toMatchObject({ holdout_source_thresholds_pass: true, holdout_operation_thresholds_pass: true, status: 'pass' });
    expect(Object.values(report.holdout_thresholds.by_source).every(result => result.cases > 0)).toBe(true);
    expect(Object.values(report.holdout_thresholds.by_operation).every(result => result.cases > 0)).toBe(true);
    const serialized = JSON.stringify(report);
    for (const item of answerEvaluationManifest) {
      expect(serialized).not.toContain(item.question);
      expect(serialized).not.toContain(item.id);
    }
    expect(serialized).not.toContain('private-model-name');
  });

  it('fails affected semantic and unsafe-answer gates', () => {
    const artifact = perfectArtifact();
    const target = artifact.observations.find(observation => observation.id === 'iid-pair')!;
    target.program = answerEvaluationManifest.find(item => item.id === 'dev-standings')!.expected.acceptable_programs![0];
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.holdout_thresholds.by_source.final_driver_standings.status).toBe('fail');
    expect(report.release_gates).toMatchObject({ unsafe_answers_zero: false, status: 'fail' });
  });

  it('fails globally and by source when a supplied reason is wrong', () => {
    const artifact = perfectArtifact();
    artifact.observations.find(observation => observation.id === 'iid-session')!.reason = 'metric_ambiguous';
    artifact.observations.find(observation => observation.id === 'iid-pair')!.reason = 'race_classification';
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.holdout_thresholds.by_source.final_driver_standings.status).toBe('fail');
    expect(report.release_gates).toMatchObject({ reasons_correct: false, status: 'fail' });
  });

  it('remains structurally disconnected from execution and raw output', () => {
    const source = readFileSync('src/f1ql/answer-observation-report.ts', 'utf8');
    const command = readFileSync('scripts/report-answer-evaluation-observations.ts', 'utf8');
    expect(source).not.toContain('executeF1QL');
    expect(source).not.toMatch(/from ['"].*executor/);
    expect(command).not.toContain('executeF1QL');
    expect(command).not.toContain('console.log');
    expect(() => reportAnswerObservationFile(process.cwd())).toThrow('not_regular_file');
  });
});
