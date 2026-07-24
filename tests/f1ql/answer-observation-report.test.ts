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
    version: 3,
    kind: 'f1ql_answer_observations',
    provider: { type: 'groq', model: 'private-model-name', collected_at: '2026-07-24T00:00:00.000Z' },
    manifest: { case_count: answerEvaluationManifest.length, sha256: getAnswerEvaluationManifestHash(answerEvaluationManifest) },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      intent_version: ANSWER_INTENT_CONTRACT_VERSION,
      translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256,
      translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations: answerEvaluationManifest.map(item => {
      const program = item.expected.acceptable_programs?.[0];
      const base = {
        id: item.id, action: item.expected.action, reason: item.expected.reason,
        translation_attempted: true, translation_latency_ms: 100, translation_timed_out: false,
        entity_candidates: [...item.canonical_entities].sort(),
        linked_entities: item.expected.action === 'answer' ? [...item.canonical_entities].sort() : []
      };
      return program ? {
        ...base, template_id: item.expected.template_id, proof_status: 'passed',
        proof_hash: 'b'.repeat(64), program_hash: getF1QLProgramHash(program)
      } : { ...base, proof_status: 'not_applicable' };
    })
  };
  modify?.(unsigned);
  return verifyAnswerObservationArtifact(answerEvaluationManifest, signAnswerObservationArtifact(answerEvaluationManifest, unsigned, signer), trustedKey);
}

describe('answer observation reporting', () => {
  it('emits aggregate template, semantic, link, latency, and timeout gates without private identifiers', () => {
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, perfectArtifact(), artifactHash);
    expect(report.artifact).toEqual({ version: 3, observations: answerEvaluationManifest.length, sha256: artifactHash, manifest_sha256: getAnswerEvaluationManifestHash(answerEvaluationManifest) });
    expect(report.contract).toMatchObject({ translator_prompt_hash: ANSWER_TRANSLATOR_PROMPT_SHA256, translator_schema_hash: ANSWER_TRANSLATOR_SCHEMA_SHA256, status: 'pass' });
    expect(Object.values(report.templates).every(value => value.cases >= 2 && value.non_development_cases >= 2 && value.exact === value.cases && value.proof_complete === value.cases)).toBe(true);
    expect(report.selection).toMatchObject({ observations_missing: 0, unsafe_answers: 0 });
    expect(report.metamorphic).toMatchObject({ groups_total: 8, groups_complete: 8, groups_consistent: 8 });
    expect(report.translation_latency).toMatchObject({ observations: answerEvaluationManifest.length, required_observations: answerEvaluationManifest.length, p95_ms: 100, max_ms: 100, status: 'pass' });
    expect(report.translation_timeouts).toEqual({ observations: answerEvaluationManifest.length, required_observations: answerEvaluationManifest.length, timed_out: 0, maximum_timeouts: 0, status: 'pass' });
    expect(report.release_gates).toMatchObject({ provider_diagnostics_zero: true, exact_templates_complete: true, exact_programs_complete: true, semantic_proofs_complete: true, status: 'pass' });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('private-model-name');
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
      for (const observation of input.observations.slice(0, 10)) {
        observation.translation_attempted = false;
        delete observation.translation_latency_ms;
      }
      input.observations[10].translation_latency_ms = 5_001;
    });
    const report = buildAnswerObservationReport(answerEvaluationManifest, answerMetamorphicGroups, artifact, artifactHash);
    expect(report.translation_outcomes).toEqual({ attempted: answerEvaluationManifest.length - 10, deterministic: 10 });
    expect(report.translation_latency.required_observations).toBe(answerEvaluationManifest.length - 10);
    expect(report.translation_timeouts.required_observations).toBe(answerEvaluationManifest.length - 10);
    expect(report.translation_latency.observations).toBe(answerEvaluationManifest.length - 10);
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
