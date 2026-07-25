import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWER_AUTHORIZATION_TTL_MS,
  ANSWER_AUTHORIZATION_VERSION,
  AnswerAuthorizationError,
  buildAnswerExecutionAuthorization,
  consumeAnswerExecutionAuthorization
} from '../../src/f1ql/answer-authorization';
import {
  ActiveAnswerReleaseContext,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationSigningPayload,
  verifyAnswerReleaseAttestation,
  verifyVerifiedAnswerReleaseAttestationValidity
} from '../../src/f1ql/answer-release-attestation';
import { createAnswerQuestionContract } from '../../src/f1ql/answer-question';
import { proveAnswerIntent } from '../../src/f1ql/answer-semantic-proof';

const hash = (digit: string) => digit.repeat(64);
const runtime = {
  max_concurrency: 2, queue_timeout_ms: 2_000, request_timeout_ms: 12_000, rate_limit_max: 10,
  rate_limit_window_ms: 900_000, statement_timeout_ms: 3_000, max_work_units: 200, max_rows: 100, max_response_bytes: 65_536
};
const keyPair = generateKeyPairSync('ed25519');
const trustedKey = { key_id: 'authorization-release-key', public_key: keyPair.publicKey };
const releaseNowMs = Date.parse('2026-07-24T00:01:00.000Z');
const activeContext = (overrides: Partial<ActiveAnswerReleaseContext> = {}): ActiveAnswerReleaseContext => ({
  release_id: 'test-release', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
  commit_sha: 'e'.repeat(40), provider: 'openai-compatible', model_id: 'reviewed-model', endpoint_sha256: hash('1'), reasoning_effort: 'disabled',
  audience: 'f1muse-answer', deployment_id: 'test-deployment',
  canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 100, canary_hmac_key_sha256: hash('7'),
  evidence_hashes: {
    manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
    result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d')
  },
  statuses: { semantic: 'pass', safety: 'pass', linker: 'pass', latency: 'pass', timeout: 'pass' },
  runtime, deployment_template_ids: ['final_standings_leader'], ...overrides
});

function release(context = activeContext()) {
  const unsigned = {
    version: 4 as const, kind: 'f1ql_answer_release_attestation' as const,
    key_id: trustedKey.key_id, ...buildActiveAnswerReleaseBindings(context)
  };
  const raw = { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), keyPair.privateKey).toString('base64') };
  return verifyAnswerReleaseAttestation(raw, trustedKey, context, { now_ms: releaseNowMs, max_validity_ms: 600_000, max_age_ms: 300_000 });
}

async function proof() {
  const question = 'Who led the 2025 standings?';
  return proveAnswerIntent(createAnswerQuestionContract(question), {
    type: 'final_standings_leader', season: 2025,
    season_reference: { text: '2025', start: 12, end: 16 }
  }, {
    resolve: async () => ({ type: 'missing' }), resolveRound: async () => ({ type: 'missing' })
  }, { inventoryMentions: async () => [] });
}

describe('one-time answer execution authorization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(releaseNowMs);
  });

  afterEach(() => {
    delete process.env.F1QL_DEFINITIONS_VERSION;
    vi.useRealTimers();
  });

  it('issues a branded, frozen, audience/deployment/release-bound short-lived authorization', async () => {
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'));
    const semanticProof = await proof();
    const attestation = release();
    const authorization = buildAnswerExecutionAuthorization(randomUUID(), 'internal', semanticProof, attestation);
    expect(authorization).toMatchObject({
      version: ANSWER_AUTHORIZATION_VERSION,
      audience: 'f1muse-answer', deployment_id: 'test-deployment',
      proof_hash: semanticProof.proof_hash, template_id: 'final_standings_leader', program_hash: semanticProof.program_hash,
      capability: { source: 'final_driver_standings', operation: 'rank', season: 2025, filters: [] },
      active_versions: { authorization: 'answer-authorization-v6', release_attestation: 4 }
    });
    expect(authorization.expires_at_ms - authorization.issued_at_ms).toBe(ANSWER_AUTHORIZATION_TTL_MS);
    expect(authorization.authorization_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(authorization)).toBe(true);
  });

  it('consumes exactly once with exact request, audience, deployment, release, versions, and time', async () => {
    const attestation = release();
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation);
    const context = { request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: attestation, is_kill_switch_active: () => false };
    expect(consumeAnswerExecutionAuthorization(authorization, context)).toBe(authorization);
    expect(() => consumeAnswerExecutionAuthorization(authorization, context)).toThrowError(expect.objectContaining({ code: 'authorization_replayed' }));
  });

  it('rejects forged/copy authority and mismatched consumption bindings', async () => {
    const attestation = release();
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation);
    expect(() => consumeAnswerExecutionAuthorization({ ...authorization }, {
      request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: attestation, is_kill_switch_active: () => false
    })).toThrowError(expect.objectContaining({ code: 'invalid_authorization' }));
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: randomUUID(), audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: attestation, is_kill_switch_active: () => false
    })).toThrowError(expect.objectContaining({ code: 'authorization_binding_mismatch' }));
  });

  it('rejects expired authorization and replay cannot be bypassed by clock changes', async () => {
    vi.setSystemTime(new Date('2026-07-24T00:00:00Z'));
    const attestation = release();
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation);
    vi.advanceTimersByTime(ANSWER_AUTHORIZATION_TTL_MS);
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: attestation, is_kill_switch_active: () => false
    })).toThrowError(expect.objectContaining({ code: 'authorization_expired' }));
  });

  it('caps authorization life at release expiry and rejects release expiry before consumption', async () => {
    const nearExpiryContext = activeContext({ expires_at: '2026-07-24T00:01:02.000Z' });
    const attestation = release(nearExpiryContext);
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation, releaseNowMs);
    expect(authorization.expires_at_ms).toBe(Date.parse(nearExpiryContext.expires_at));
    expect(authorization.expires_at_ms - authorization.issued_at_ms).toBe(2_000);
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id,
      release_attestation: attestation, is_kill_switch_active: () => false
    }, authorization.expires_at_ms)).toThrowError(expect.objectContaining({ code: 'release_expired' }));
  });

  it('rechecks an already branded release immediately before authorization issuance', async () => {
    const attestation = release();
    const semanticProof = await proof();
    expect(verifyVerifiedAnswerReleaseAttestationValidity(attestation, releaseNowMs)).toBe(attestation);
    expect(() => buildAnswerExecutionAuthorization(
      randomUUID(), 'internal', semanticProof, attestation, Date.parse(attestation.expires_at)
    )).toThrowError(expect.objectContaining({ code: 'release_expired' }));
  });

  it('rejects a changed active release hash and active definitions at consumption', async () => {
    const attestation = release();
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation);
    const otherContext = activeContext({ deployment_id: 'other-deployment' });
    const otherRelease = release(otherContext);
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: otherRelease, is_kill_switch_active: () => false
    })).toThrowError(expect.objectContaining({ code: 'authorization_binding_mismatch' }));
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: requestId, audience: attestation.audience, deployment_id: attestation.deployment_id, release_attestation: attestation, is_kill_switch_active: () => false
    })).toThrowError(expect.objectContaining({ code: 'authorization_binding_mismatch' }));
  });

  it('fails closed when the live kill switch changes before consumption', async () => {
    const attestation = release();
    const requestId = randomUUID();
    const authorization = buildAnswerExecutionAuthorization(requestId, 'internal', await proof(), attestation);
    expect(() => consumeAnswerExecutionAuthorization(authorization, {
      request_id: requestId,
      audience: attestation.audience,
      deployment_id: attestation.deployment_id,
      release_attestation: attestation,
      is_kill_switch_active: () => true
    })).toThrowError(expect.objectContaining({ code: 'kill_switch_active' }));
  });

  it('rejects invalid requests, forged inputs, unlisted templates, and inactive definitions', async () => {
    const semanticProof = await proof();
    const attestation = release();
    expect(() => buildAnswerExecutionAuthorization('caller-controlled', 'internal', semanticProof, attestation)).toThrow(AnswerAuthorizationError);
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'internal', { ...semanticProof } as never, attestation)).toThrow(AnswerAuthorizationError);
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'internal', semanticProof, { ...attestation } as never)).toThrow(AnswerAuthorizationError);
    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'internal', semanticProof, attestation)).toThrow(AnswerAuthorizationError);
  });
});
