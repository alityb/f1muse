import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAnswerObservationReport } from '../../src/f1ql/answer-observation-report';
import { reportAnswerObservationFile } from '../../scripts/report-answer-evaluation-observations';
import { createAnswerObservationSigningHelper, getAnswerEvaluationManifestHash, signAnswerObservationArtifact, validateAnswerObservationArtifact, verifyAnswerObservationArtifact } from '../../src/f1ql/answer-observations';
import { ANSWER_QUESTION_CONTRACT_VERSION } from '../../src/f1ql/answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION } from '../../src/f1ql/answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from '../../src/f1ql/answer-templates';
import { ANSWER_INTENT_CONTRACT_VERSION } from '../../src/f1ql/answer-translator';
import { ANSWER_TRANSLATOR_PROMPT_SHA256, ANSWER_TRANSLATOR_SCHEMA_SHA256 } from '../../src/f1ql/answer-translator';
import { getF1QLProgramHash } from '../../src/f1ql/verified-programs';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const artifactHash = 'a'.repeat(64);
const keyId = 'evaluation-report-key';
const keys = generateKeyPairSync('ed25519');
const signer = createAnswerObservationSigningHelper(keyId, keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
const trustedKey = { key_id: keyId, public_key_base64: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const reportEnv = { F1QL_ANSWER_EVALUATION_KEY_ID: keyId, F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64: trustedKey.public_key_base64 };

function perfectArtifact(modify?: (artifact: any) => void) {
  const unsigned: any = {
    version: 4,
    kind: 'f1ql_answer_observations',
    provider: {
      type: 'groq', model: 'private-model-name', endpoint_sha256: '1'.repeat(64),
      reasoning_effort: 'disabled', collected_at: '2026-07-24T00:00:00.000Z'
    },
    manifest: { case_count: answerEvaluationManifest.length, sha256: getAnswerEvaluationManifestHash(answerEvaluationManifest) },
    reliability: { answerable_observations_per_case: 3, non_answerable_observations_per_case: 1 },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      intent_version: ANSWER_INTENT_CONTRACT_VERSION,
      translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256,
      translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations: answerEvaluationManifest.flatMap(item => Array.from({ length: item.answerable ? 3 : 1 }, (_, observationIndex) => {
      const program = item.expected.acceptable_programs?.[0];
      const base = {
        id: item.id, observation_index: observationIndex, action: item.expected.action, reason: item.expected.reason,
        translation_attempted: true, translation_latency_ms: 100, translation_timed_out: false,
        entity_candidates: [...item.canonical_entities].sort(),
        linked_entities: item.expected.action === 'answer' ? [...item.canonical_entities].sort() : []
      };
      return program ? {
        ...base, template_id: item.expected.template_id, proof_status: 'passed',
        proof_hash: 'b'.repeat(64), program_hash: getF1QLProgramHash(program)
      } : { ...base, proof_status: 'not_applicable' };
    }))
  };
  modify?.(unsigned);
  return verifyAnswerObservationArtifact(answerEvaluationManifest, signAnswerObservationArtifact(answerEvaluationManifest, unsigned, signer), trustedKey);
}

describe('answer observation reporting', () => {
  it('emits aggregate template, semantic, link, latency, and timeout gates without private identifiers', () => {
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, perfectArtifact(), artifactHash);
    expect(report.version).toBe(3);
    expect(report.artifact).toEqual({ version: 4, observations: answerEvaluationManifest.reduce((count, item) => count + (item.answerable ? 3 : 1), 0), sha256: artifactHash, manifest_sha256: getAnswerEvaluationManifestHash(answerEvaluationManifest) });
    expect(report.contract).toMatchObject({ translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256, translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256, status: 'pass' });
    expect(report.provider_evidence).toEqual({ provider: 'groq', endpoint_sha256: '1'.repeat(64), reasoning_effort: 'disabled', status: 'pass' });
    expect(Object.values(report.templates).every(value => value.cases >= 2 && value.non_development_cases >= 2 && value.exact === value.cases && value.proof_complete === value.cases)).toBe(true);
    expect(report.selection).toMatchObject({ observations_missing: 0, unsafe_answers: 0 });
    expect(report.metamorphic).toMatchObject({ groups_total: 8, groups_complete: 8, groups_consistent: 8 });
    expect(report.translation_latency).toMatchObject({ observations: report.artifact.observations, required_observations: report.artifact.observations, p95_ms: 100, max_ms: 100, status: 'pass' });
    expect(report.translation_timeouts).toEqual({ observations: report.artifact.observations, required_observations: report.artifact.observations, timed_out: 0, maximum_timeouts: 0, status: 'pass' });
    expect(report.release_gates).toMatchObject({ provider_diagnostics_zero: true, exact_templates_complete: true, exact_programs_complete: true, semantic_proofs_complete: true, status: 'pass' });
    expect(report.reliability).toMatchObject({ answerable_cases: 44, required_observations: 132, supplied_observations: 132, complete_cases: 44, status: 'pass' });
    for (const field of ['action', 'reason', 'template_id', 'program_hash'] as const) {
      expect(report.reliability[field]).toEqual({ exact_cases: 44, drift_cases: 0 });
    }
    expect(report.release_gates).toMatchObject({ repetition_completeness: true, repeated_exactness: true, zero_repetition_drift: true });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('private-model-name');
    expect(serialized).not.toContain('https://');
    expect(serialized).toContain(artifactHash);
    expect(serialized).toContain(ANSWER_TEMPLATE_REGISTRY_HASH);
    for (const item of answerEvaluationManifest) {
      expect(serialized).not.toContain(item.question);
      expect(serialized).not.toContain(item.id);
      expect(serialized).not.toContain(item.canonical_entities[0] ?? '__no_entity__');
    }
  });

  it('excludes deterministic outcomes from attempted-call latency and timeout denominators', () => {
    const artifact = perfectArtifact(input => {
      const nonAnswerableIds = new Set(answerEvaluationManifest.filter(item => !item.answerable).slice(0, 10).map(item => item.id));
      for (const observation of input.observations.filter((item: any) => nonAnswerableIds.has(item.id))) {
        observation.translation_attempted = false;
        delete observation.translation_latency_ms;
      }
      input.observations.find((item: any) => !nonAnswerableIds.has(item.id)).translation_latency_ms = 5_001;
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.translation_outcomes).toEqual({ attempted: report.artifact.observations - 10, deterministic: 10 });
    expect(report.translation_latency.required_observations).toBe(report.artifact.observations - 10);
    expect(report.translation_timeouts.required_observations).toBe(report.artifact.observations - 10);
    expect(report.translation_latency.observations).toBe(report.artifact.observations - 10);
  });

  it('normalizes historical diagnostics and fails release on every provider diagnostic', () => {
    const artifact = perfectArtifact(input => {
      const target = input.observations.find((item: any) => item.id === 'dev-ambiguous')!;
      Object.assign(target, { action: 'abstain', reason: 'provider_error', provider_diagnostic_code: 'quota' });
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.provider_diagnostics).toMatchObject({ observations: 1, counts: { quota: 1, auth: 0, transport: 0 } });
    expect(report.release_gates).toMatchObject({ provider_diagnostics_zero: false, status: 'fail' });
  });

  it('requires exact actions independently from exact reasons', () => {
    const artifact = perfectArtifact(input => {
      const target = input.observations.find((item: any) => item.action === 'clarify')!;
      target.action = 'abstain';
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.selection.reason_correct).toBe(report.selection.total);
    expect(report.selection.action_correct).toBe(report.selection.total - 1);
    expect(report.release_gates).toMatchObject({ actions_correct: false, reasons_correct: true, status: 'fail' });
  });

  it.each([
    ['action', (target: any) => {
      Object.assign(target, { action: 'abstain', proof_status: 'failed' });
      delete target.template_id; delete target.proof_hash; delete target.program_hash;
    }],
    ['reason', (target: any) => { target.reason = target.reason === 'race_classification' ? 'final_driver_standings' : 'race_classification'; }],
    ['template_id', (target: any) => { target.template_id = target.template_id === 'race_classification_driver' ? 'final_standings_leader' : 'race_classification_driver'; }],
    ['program_hash', (target: any) => { target.program_hash = 'f'.repeat(64); }]
  ] as const)('fails v4 %s drift outside observation index zero', (field, mutate) => {
    const artifact = perfectArtifact(input => {
      const linkIds = new Set(answerEvaluationManifest.filter(item => item.answerable && item.canonical_entities.length > 0 && (item.acceptable_linked_entities?.length ?? 0) > 0).map(item => item.id));
      const target = input.observations.find((item: any) => item.observation_index === 2 && linkIds.has(item.id))!;
      mutate(target);
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.selection.action_correct).toBe(report.selection.total);
    expect(report.reliability[field].drift_cases).toBe(1);
    expect(report.release_gates).toMatchObject({ zero_repetition_drift: false, status: 'fail' });
  });

  it('fails identical repeated wrong values without calling them drift', () => {
    const artifact = perfectArtifact(input => {
      const id = input.observations.find((item: any) => item.action === 'answer')!.id;
      for (const target of input.observations.filter((item: any) => item.id === id)) target.reason = 'race_classification';
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.reliability.reason).toEqual({ exact_cases: 43, drift_cases: 0 });
    expect(report.release_gates).toMatchObject({ repeated_exactness: false, zero_repetition_drift: true, status: 'fail' });
  });

  it('marks a canonical missing repetition insufficient rather than drift', () => {
    const artifact = perfectArtifact(input => {
      const id = input.observations.find((item: any) => item.action === 'answer')!.id;
      input.observations = input.observations.filter((item: any) => item.id !== id || item.observation_index !== 2);
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.reliability).toMatchObject({ supplied_observations: 131, complete_cases: 43, status: 'insufficient' });
    expect(report.release_gates).toMatchObject({ repetition_completeness: false, repeated_exactness: false, zero_repetition_drift: true, status: 'insufficient' });
  });

  it('retains low-cardinality proof rejection reasons and never credits provider abstention as proof rejection', () => {
    const artifact = perfectArtifact(input => {
      const target = input.observations.find((item: any) => item.id === 'attack-event')!;
      target.reason = 'entity_cardinality_mismatch';
      target.proof_status = 'failed';
    });
    let report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.proof_rejections.observations).toBeGreaterThan(0);
    expect(report.proof_rejections.counts.entity_cardinality_mismatch).toBeGreaterThan(0);

    const providerArtifact = perfectArtifact(input => {
      const target = input.observations.find((item: any) => item.id === 'attack-event')!;
      Object.assign(target, { reason: 'provider_error', proof_status: 'failed', provider_diagnostic_code: 'transport' });
    });
    report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, providerArtifact, artifactHash);
    expect(report.selection.reason_correct).toBeLessThan(report.selection.total);
    expect(report.release_gates).toMatchObject({ reasons_correct: false, provider_diagnostics_zero: false, status: 'fail' });
  });

  it('fails causal timeout and latency violations', () => {
    const timedOut = perfectArtifact(input => {
      const target = input.observations.find((item: any) => item.id === 'dev-ambiguous')!;
      Object.assign(target, { action: 'abstain', reason: 'provider_error', provider_diagnostic_code: 'request_timeout', translation_timed_out: true, translation_latency_ms: 15_000 });
    });
    const timeoutReport = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, timedOut, artifactHash);
    expect(timeoutReport.translation_timeouts.status).toBe('fail');
    expect(timeoutReport.release_gates.status).toBe('fail');

    const slow = perfectArtifact(input => { input.observations[0].translation_latency_ms = 10_001; });
    expect(buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, slow, artifactHash).translation_latency.status).toBe('fail');
  });

  it('accounts for timeout, diagnostics, proof rejection, and links on later repetitions', () => {
    const artifact = perfectArtifact(input => {
      const linkIds = new Set(answerEvaluationManifest.filter(item => item.answerable && item.canonical_entities.length > 0 && (item.acceptable_linked_entities?.length ?? 0) > 0).map(item => item.id));
      const target = input.observations.find((item: any) => item.observation_index === 2 && linkIds.has(item.id))!;
      Object.assign(target, {
        action: 'abstain', reason: 'provider_error', provider_diagnostic_code: 'request_timeout',
        translation_timed_out: true, translation_latency_ms: 15_000, proof_status: 'failed',
        entity_candidates: [], linked_entities: []
      });
      delete target.template_id; delete target.proof_hash; delete target.program_hash;
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.translation_timeouts.timed_out).toBe(1);
    expect(report.provider_diagnostics).toMatchObject({ observations: 1, counts: { request_timeout: 1 } });
    expect(report.release_gates).toMatchObject({ candidate_recall_complete: false, canonical_links_complete: false, semantic_proofs_complete: false, status: 'fail' });
  });

  it('requires verified provenance and refuses forged proof evidence or a tampered file', () => {
    const verified = perfectArtifact();
    const forged = structuredClone(verified);
    forged.observations.find(item => item.action === 'answer')!.proof_hash = 'f'.repeat(64);
    expect(() => buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, forged, artifactHash)).toThrow('unverified');

    const directory = mkdtempSync(join(tmpdir(), 'answer-observation-report-'));
    try {
      const path = join(directory, 'artifact.json');
      const serialized = `${JSON.stringify(verified)}\n`;
      writeFileSync(path, serialized);
      expect(reportAnswerObservationFile(path, reportEnv).release_gates.status).toBe('pass');
      const tampered = JSON.parse(serialized);
      tampered.observations.find((item: any) => item.action === 'answer').program_hash = 'e'.repeat(64);
      writeFileSync(path, `${JSON.stringify(tampered)}\n`);
      expect(() => reportAnswerObservationFile(path, reportEnv)).toThrow('signature_invalid');
      expect(createHash('sha256').update(serialized).digest('hex')).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains explicit historical artifact compatibility but marks proof evidence insufficient', () => {
    const modern = perfectArtifact();
    const legacy = validateAnswerObservationArtifact(answerEvaluationManifest, {
      version: 1, kind: 'f1ql_answer_observations', provider: { type: 'openai-compatible', model: 'legacy', collected_at: '2026-07-24T00:00:00.000Z' },
      manifest: modern.manifest,
      observations: answerEvaluationManifest.map(item => ({
        id: item.id, action: item.expected.action, reason: item.expected.reason,
        ...(item.expected.acceptable_programs ? { program: item.expected.acceptable_programs[0] } : {}),
        entity_candidates: [...item.canonical_entities].sort(), linked_entities: item.expected.action === 'answer' ? [...item.canonical_entities].sort() : []
      }))
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, legacy, artifactHash);
    expect(report.translation_latency.status).toBe('insufficient');
    expect(report.translation_timeouts.status).toBe('insufficient');
    expect(report.reliability).toMatchObject({ supplied_observations: 44, complete_cases: 0, status: 'insufficient' });
    expect(report.release_gates.semantic_proofs_complete).toBe(false);
    expect(report.release_gates.status).toBe('insufficient');
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
