import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertDisposableDerivationDatabase } from '../../scripts/collect-answer-derivation-evidence';
import { buildAnswerDerivationReport } from '../../src/f1ql/answer-derivation-report';
import {
  getAnswerDerivationManifestHash,
  isVerifiedAnswerDerivationEvidence,
  parseAnswerDerivationEvidence,
  signAnswerDerivationEvidence,
  verifyAnswerDerivationEvidence
} from '../../src/f1ql/answer-derivation-evidence';
import { ANSWER_INTENT_SCHEMA_VERSION } from '../../src/f1ql/answer-intent';
import { ANSWER_INTENT_DERIVATION_VERSION } from '../../src/f1ql/answer-intent-derivation';
import { ANSWER_QUESTION_CONTRACT_VERSION } from '../../src/f1ql/answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION } from '../../src/f1ql/answer-semantic-proof';
import { ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from '../../src/f1ql/answer-templates';
import { getF1QLProgramHash } from '../../src/f1ql/verified-programs';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const keys = generateKeyPairSync('ed25519');
const signer = {
  key_id: 'derivation-evaluation-key',
  private_key_base64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
};
const trusted = {
  key_id: signer.key_id,
  public_key_base64: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
};

function unsignedArtifact() {
  return {
    version: 1 as const,
    kind: 'f1ql_answer_derivation_evidence' as const,
    collected_at: '2026-07-24T00:00:00.000Z',
    manifest: { case_count: answerEvaluationManifest.length, sha256: getAnswerDerivationManifestHash(answerEvaluationManifest) },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      derivation_version: ANSWER_INTENT_DERIVATION_VERSION,
      intent_schema_version: ANSWER_INTENT_SCHEMA_VERSION,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations: answerEvaluationManifest.map(item => ({
      id: item.id,
      action: item.expected.action,
      reason: item.expected.reason,
      ...(item.expected.action === 'answer' ? {
        template_id: item.expected.template_id,
        proof_hash: createHash('sha256').update(`proof:${item.id}`).digest('hex'),
        program_hash: getF1QLProgramHash(item.expected.acceptable_programs![0])
      } : {}),
      entity_candidates: item.canonical_entities,
      linked_entities: item.expected.action === 'answer' ? item.canonical_entities : []
    }))
  };
}

describe('deterministic answer derivation evidence', () => {
  it('signs, verifies, and deeply freezes the complete canonical artifact', () => {
    const signed = signAnswerDerivationEvidence(answerEvaluationManifest, unsignedArtifact(), signer);
    const verified = verifyAnswerDerivationEvidence(answerEvaluationManifest, signed, trusted);
    expect(isVerifiedAnswerDerivationEvidence(verified)).toBe(true);
    expect(verified.observations).toHaveLength(106);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.observations[0].entity_candidates)).toBe(true);
  });

  it('rejects tampering, duplicate, missing, reordered, extra, and forbidden sensitive fields', () => {
    const signed = signAnswerDerivationEvidence(answerEvaluationManifest, unsignedArtifact(), signer);
    expect(() => verifyAnswerDerivationEvidence(answerEvaluationManifest, {
      ...signed,
      observations: signed.observations.map((item, index) => index === 0 ? { ...item, reason: 'race_classification' } : item)
    }, trusted)).toThrow('answer_derivation_signature_invalid');
    expect(() => signAnswerDerivationEvidence(answerEvaluationManifest, {
      ...unsignedArtifact(), observations: [unsignedArtifact().observations[0], ...unsignedArtifact().observations]
    }, signer)).toThrow('answer_derivation_observation_duplicate');
    expect(() => signAnswerDerivationEvidence(answerEvaluationManifest, {
      ...unsignedArtifact(), observations: unsignedArtifact().observations.slice(1)
    }, signer)).toThrow('answer_derivation_observation_order_or_cardinality_invalid');
    expect(() => signAnswerDerivationEvidence(answerEvaluationManifest, {
      ...unsignedArtifact(), observations: [unsignedArtifact().observations[1], unsignedArtifact().observations[0], ...unsignedArtifact().observations.slice(2)]
    }, signer)).toThrow('answer_derivation_observation_order_or_cardinality_invalid');
    expect(() => parseAnswerDerivationEvidence({ ...signed, provider: 'forbidden' })).toThrow('answer_derivation_artifact_invalid');
    expect(() => parseAnswerDerivationEvidence({
      ...signed,
      observations: signed.observations.map((item, index) => index === 0 ? { ...item, question: 'forbidden' } : item)
    })).toThrow('answer_derivation_artifact_invalid');
  });

  it('emits only aggregate passing gates at exact 106/106 and 71/71', () => {
    const verified = verifyAnswerDerivationEvidence(
      answerEvaluationManifest,
      signAnswerDerivationEvidence(answerEvaluationManifest, unsignedArtifact(), signer),
      trusted
    );
    const report = buildAnswerDerivationReport(answerEvaluationManifest, answerMetamorphicGroups, verified, 'a'.repeat(64));
    expect(report.counts).toMatchObject({
      cases: 106, actions_correct: 106, reasons_correct: 106, programs_exact: 71,
      programs_required: 71, templates_exact: 71, proofs_complete: 71,
      unsafe_answers: 0, forbidden_answers: 0, missing_observations: 0
    });
    expect(report.release_gates.status).toBe('pass');
    const serialized = JSON.stringify(report);
    for (const item of answerEvaluationManifest) {
      expect(serialized).not.toContain(item.id);
      expect(serialized).not.toContain(item.question);
    }
    expect(serialized).not.toMatch(/proof_hash|provider|model|endpoint|program_hash/);
  });

  it('fails independent semantic, link, metamorphic, and safety gates', () => {
    const input = unsignedArtifact();
    const first = input.observations.find(item => item.id === 'dev-race-driver')!;
    Object.assign(first, { program_hash: 'f'.repeat(64), linked_entities: [] });
    const verified = verifyAnswerDerivationEvidence(
      answerEvaluationManifest,
      signAnswerDerivationEvidence(answerEvaluationManifest, input, signer),
      trusted
    );
    const report = buildAnswerDerivationReport(answerEvaluationManifest, answerMetamorphicGroups, verified, 'b'.repeat(64));
    expect(report.release_gates).toMatchObject({
      templates_programs_and_proofs_exact: false,
      canonical_links_complete: false,
      metamorphic_groups_complete: false,
      unsafe_and_forbidden_answers_zero: false,
      status: 'fail'
    });
  });

  it('keeps collector and report entrypoints structurally executor-free', () => {
    const source = [
      readFileSync('scripts/collect-answer-derivation-evidence.ts', 'utf8'),
      readFileSync('scripts/report-answer-derivation-evidence.ts', 'utf8'),
      readFileSync('src/f1ql/answer-derivation-evidence.ts', 'utf8')
    ].join('\n');
    expect(source).not.toMatch(/executeF1QL|executeAuthorizedAnswer|answer-execution|\.\/executor/);
    expect(source).not.toMatch(/fetch\s*\(|answer-translator|model-provider/);
  });

  it('accepts only the exact disposable localhost database URL', () => {
    expect(() => assertDisposableDerivationDatabase('postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test')).not.toThrow();
    for (const url of [
      'postgresql://postgres:postgres@localhost:5433/f1muse_test',
      'postgresql://postgres:postgres@127.0.0.1:5433/f1muse_test?sslmode=disable',
      'postgresql://postgres:postgres@example.test:5433/f1muse_test'
    ]) {
      expect(() => assertDisposableDerivationDatabase(url)).toThrow('exact disposable Docker database');
    }
  });
});
