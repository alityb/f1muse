import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AnswerCanaryError,
  getAnswerCanaryStage,
  selectAnswerCanaryCohort
} from '../../src/f1ql/answer-canary';
import {
  ActiveAnswerReleaseContext,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationSigningPayload,
  verifyAnswerReleaseAttestation
} from '../../src/f1ql/answer-release-attestation';

const h = (value: string) => value.repeat(64);
const runtime = {
  max_concurrency: 2, queue_timeout_ms: 2_000, request_timeout_ms: 12_000, rate_limit_max: 10,
  rate_limit_window_ms: 900_000, statement_timeout_ms: 3_000, max_work_units: 200, max_rows: 100, max_response_bytes: 65_536
};
const hmacKeyBase64 = Buffer.alloc(32, 7).toString('base64');
const hmacKeySha256 = createHash('sha256').update(Buffer.alloc(32, 7)).digest('hex');
const context: ActiveAnswerReleaseContext = {
  release_id: 'test-release', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
  commit_sha: 'e'.repeat(40), audience: 'f1muse-answer', deployment_id: 'test-deployment',
  evidence_hashes: {
    manifest_sha256: h('8'), artifact_sha256: h('9'), report_sha256: h('a'), result_fixture_sha256: h('b'),
    principal_audit_sha256: h('c'), production_evidence_sha256: h('d')
  },
  statuses: { semantic: 'pass', safety: 'pass', linker: 'pass' },
  runtime, deployment_template_ids: ['race-v1'], deployment_principal_classes: ['internal_canary'],
  canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 100, canary_hmac_key_sha256: hmacKeySha256
};
const keyPair = generateKeyPairSync('ed25519');
const key = { key_id: 'canary-release-key', public_key: keyPair.publicKey };
const unsigned = { version: 6 as const, kind: 'f1ql_answer_release_attestation' as const, key_id: key.key_id, ...buildActiveAnswerReleaseBindings(context) };
const raw = { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), keyPair.privateKey).toString('base64') };
const attestation = verifyAnswerReleaseAttestation(raw, key, context, {
  now_ms: Date.parse('2026-07-24T00:01:00.000Z'), max_validity_ms: 600_000, max_age_ms: 300_000
});
const input = {
  kill_switch: false,
  stage: 100,
  template_id: 'race-v1',
  deployment_template_ids: ['race-v1'],
  attestation,
  now_ms: Date.parse('2026-07-24T00:01:00.000Z')
};

describe('answer canary', () => {
  it('defaults production to stage zero and accepts only reviewed rollout stages', () => {
    expect(getAnswerCanaryStage({})).toBe(0);
    for (const stage of [0, 1, 5, 25, 50, 100]) {
      expect(getAnswerCanaryStage({ F1QL_ANSWER_CANARY_STAGE: String(stage) })).toBe(stage);
    }
    for (const stage of ['-1', '2', '24', '99', '101', 'NaN', ' 5', '05']) {
      expect(() => getAnswerCanaryStage({ F1QL_ANSWER_CANARY_STAGE: stage })).toThrow(AnswerCanaryError);
    }
  });

  it('stage zero returns control before inspecting attestation, template, identity, or salt', () => {
    expect(selectAnswerCanaryCohort({ kill_switch: false, stage: 0 })).toEqual({ cohort: 'control', reason: 'stage_zero', stage: 0 });
    expect(selectAnswerCanaryCohort({
      kill_switch: false, stage: 0, template_id: '', deployment_template_ids: [],
      attestation: raw as never
    })).toEqual({ cohort: 'control', reason: 'stage_zero', stage: 0 });
  });

  it('admits full release only after signed attestation and template checks', () => {
    expect(selectAnswerCanaryCohort(input)).toEqual({ cohort: 'canary', reason: 'full_release', stage: 100 });
  });

  it('assigns stable HMAC cohorts that are nested across increasing stages', () => {
    const subjects = Array.from({ length: 1_000 }, (_, index) => `server-subject-${index}`);
    let previous = new Set<string>();
    for (const stage of [1, 5, 25, 50] as const) {
      const selected = new Set(subjects.filter(subject_id => selectAnswerCanaryCohort({
        ...input, stage, subject_id, hmac_key_base64: hmacKeyBase64
      }).cohort === 'canary'));
      expect(selected.size).toBeGreaterThan(previous.size);
      expect([...previous].every(subject => selected.has(subject))).toBe(true);
      expect(selectAnswerCanaryCohort({ ...input, stage, subject_id: subjects[42], hmac_key_base64: hmacKeyBase64 }))
        .toEqual(selectAnswerCanaryCohort({ ...input, stage, subject_id: subjects[42], hmac_key_base64: hmacKeyBase64 }));
      previous = selected;
    }
  });

  it('locks cohort assignment to reviewed HMAC vectors', () => {
    const expected = [
      ['server-subject-0', ['control', 'control', 'control', 'control']],
      ['server-subject-1', ['control', 'control', 'canary', 'canary']],
      ['server-subject-42', ['control', 'control', 'control', 'canary']]
    ] as const;
    for (const [subject_id, cohorts] of expected) {
      expect(([1, 5, 25, 50] as const).map(stage => selectAnswerCanaryCohort({
        ...input, stage, subject_id, hmac_key_base64: hmacKeyBase64
      }).cohort)).toEqual(cohorts);
    }
  });

  it('fails closed when the live stage or HMAC key is not release-attested', () => {
    const limitedContext = { ...context, maximum_canary_stage: 5 } as ActiveAnswerReleaseContext;
    const limitedUnsigned = { version: 6 as const, kind: 'f1ql_answer_release_attestation' as const, key_id: key.key_id, ...buildActiveAnswerReleaseBindings(limitedContext) };
    const limitedRaw = { ...limitedUnsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(limitedUnsigned), keyPair.privateKey).toString('base64') };
    const limited = verifyAnswerReleaseAttestation(limitedRaw, key, limitedContext, {
      now_ms: Date.parse('2026-07-24T00:01:00.000Z'), max_validity_ms: 600_000, max_age_ms: 300_000
    });
    expect(selectAnswerCanaryCohort({ ...input, stage: 25, subject_id: 'server-subject', hmac_key_base64: hmacKeyBase64, attestation: limited }))
      .toMatchObject({ cohort: 'control', reason: 'stage_not_attested' });
    expect(selectAnswerCanaryCohort({ ...input, stage: 25, subject_id: 'server-subject', hmac_key_base64: Buffer.alloc(32, 8).toString('base64') }))
      .toMatchObject({ cohort: 'control', reason: 'key_not_attested' });
  });

  it('requires a bounded server subject and canonical 32-64 byte Base64 key for staged rollout', () => {
    for (const changed of [
      { subject_id: '', hmac_key_base64: hmacKeyBase64 },
      { subject_id: 'server-subject', hmac_key_base64: `${hmacKeyBase64}\n` },
      { subject_id: 'server-subject', hmac_key_base64: Buffer.alloc(31).toString('base64') }
    ]) {
      expect(() => selectAnswerCanaryCohort({ ...input, stage: 25, ...changed })).toThrow(AnswerCanaryError);
    }
  });

  it('requires independent deployment and signed-attestation template allowlists', () => {
    expect(selectAnswerCanaryCohort({ ...input, deployment_template_ids: ['other-v1'] })).toMatchObject({ cohort: 'control', reason: 'template_not_allowed' });
    expect(selectAnswerCanaryCohort({ ...input, template_id: 'other-v1', deployment_template_ids: ['other-v1'] })).toMatchObject({ cohort: 'control', reason: 'template_not_allowed' });
    expect(selectAnswerCanaryCohort({ ...input, attestation: raw as never })).toMatchObject({ cohort: 'control', reason: 'attestation_absent' });
    expect(() => selectAnswerCanaryCohort({ ...input, deployment_template_ids: ['z-v1', 'a-v1'] })).toThrow(AnswerCanaryError);
  });

});
