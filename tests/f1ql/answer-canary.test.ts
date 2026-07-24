import { generateKeyPairSync, sign } from 'node:crypto';
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
const context: ActiveAnswerReleaseContext = {
  release_id: 'test-release', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
  commit_sha: 'e'.repeat(40), provider: 'groq', model_id: 'reviewed-model', endpoint_sha256: h('1'), reasoning_effort: 'disabled', audience: 'f1muse-answer', deployment_id: 'test-deployment',
  evidence_hashes: {
    manifest_sha256: h('8'), artifact_sha256: h('9'), report_sha256: h('a'), result_fixture_sha256: h('b'),
    principal_audit_sha256: h('c'), production_evidence_sha256: h('d')
  },
  statuses: { semantic: 'pass', safety: 'pass', linker: 'pass', latency: 'pass', timeout: 'pass' },
  runtime, deployment_template_ids: ['race-v1']
};
const keyPair = generateKeyPairSync('ed25519');
const key = { key_id: 'canary-release-key', public_key: keyPair.publicKey };
const unsigned = { version: 3 as const, kind: 'f1ql_answer_release_attestation' as const, key_id: key.key_id, ...buildActiveAnswerReleaseBindings(context) };
const raw = { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), keyPair.privateKey).toString('base64') };
const attestation = verifyAnswerReleaseAttestation(raw, key, context, {
  now_ms: Date.parse('2026-07-24T00:01:00.000Z'), max_validity_ms: 600_000, max_age_ms: 300_000
});
const input = {
  kill_switch: false,
  stage: 100,
  template_id: 'race-v1',
  deployment_template_ids: ['race-v1'],
  attestation
};

describe('answer canary', () => {
  it('defaults production to stage zero and accepts only control or full release', () => {
    expect(getAnswerCanaryStage({})).toBe(0);
    for (const stage of [0, 100]) {
      expect(getAnswerCanaryStage({ F1QL_ANSWER_CANARY_STAGE: String(stage) })).toBe(stage);
    }
    for (const stage of ['-1', '1', '5', '25', '50', '99', '101', 'NaN']) {
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

  it('requires independent deployment and signed-attestation template allowlists', () => {
    expect(selectAnswerCanaryCohort({ ...input, deployment_template_ids: ['other-v1'] })).toMatchObject({ cohort: 'control', reason: 'template_not_allowed' });
    expect(selectAnswerCanaryCohort({ ...input, template_id: 'other-v1', deployment_template_ids: ['other-v1'] })).toMatchObject({ cohort: 'control', reason: 'template_not_allowed' });
    expect(selectAnswerCanaryCohort({ ...input, attestation: raw as never })).toMatchObject({ cohort: 'control', reason: 'attestation_absent' });
    expect(() => selectAnswerCanaryCohort({ ...input, deployment_template_ids: ['z-v1', 'a-v1'] })).toThrow(AnswerCanaryError);
  });

  it('rejects intermediate percentage stages before cohort selection', () => {
    for (const stage of [1, 5, 25, 50]) {
      expect(() => selectAnswerCanaryCohort({ ...input, stage })).toThrowError(
        expect.objectContaining({ code: 'invalid_canary_configuration' })
      );
    }
  });
});
