import { describe, expect, it } from 'vitest';
import { parseOfficialTimingQuestion, OfficialTimingQuestionMatch } from '../../src/f1ql/official-timing-question';
import { enumerateOfficialTimingEvidence } from '../../src/f1ql/official-timing-semantic-query';
import {
  collectOfficialTimingResolution,
  OfficialTimingResolutionDependencies
} from '../../src/f1ql/official-timing-resolution';
import { planOfficialTimingAnswer } from '../../src/f1ql/official-timing-plan';
import { runOfficialTimingPlannedPipeline } from '../../src/f1ql/official-timing-compiler';
import { proveOfficialTimingPlan } from '../../src/f1ql/official-timing-proof';
import {
  getOfficialTimingCapabilityProfileHash,
  OFFICIAL_TIMING_CAPABILITY_PROFILE,
  OFFICIAL_TIMING_CAPABILITY_PROFILE_ID,
  OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION,
  OFFICIAL_TIMING_CATALOG_V2_SHA256
} from '../../src/f1ql/official-timing-capability';
import {
  authorizeOfficialTimingCapability,
  consumeOfficialTimingCapabilityAuthorization,
  OFFICIAL_TIMING_AUTHORIZATION_TTL_MS,
  OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_VERSION,
  OfficialTimingAuthorizationError,
  OfficialTimingReleaseBinding
} from '../../src/f1ql/official-timing-authorization';
import { WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE } from '../../src/f1ql/wp12-official-timing-activation-bundle';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';
import { WP12_OFFICIAL_TIMING_INTERFACE_TARGET } from '../../src/f1ql/wp12-official-timing-interface-target';
import { WP12_OFFICIAL_TIMING_SEMANTIC_TARGET } from '../../src/f1ql/wp12-official-timing-semantic-target';

const CATALOG_V2 = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
const DRIVERS: Readonly<Record<string, string>> = {
  'Max Verstappen': 'max-verstappen',
  'Fernando Alonso': 'fernando-alonso'
};
const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const EVENT_MEAN_QUESTION = 'Who was faster between Max Verstappen and Fernando Alonso at the 2022 Belgian Grand Prix?';

function matched(question: string): OfficialTimingQuestionMatch {
  const result = parseOfficialTimingQuestion(question);
  if (result.type !== 'matched') {throw new Error(`expected match, got ${result.reason}`);}
  return result;
}

function dependenciesFor(metric: string): OfficialTimingResolutionDependencies {
  return {
    database: { connect: () => { throw new Error('no database in unit tests'); } } as never,
    catalog: CATALOG_V2,
    driver_resolver: {
      resolveUnambiguous: async (alias: string) => {
        const id = DRIVERS[alias];
        return id
          ? { success: true, f1db_driver_id: id, candidates: [id], match_mode: 'literal' }
          : { success: false, error: 'unknown_driver' };
      }
    },
    event_resolver: {
      resolveRound: async (season: number, round: number) =>
        season === 2022 && round === 14 ? { type: 'resolved', season, round } : { type: 'missing' }
    },
    coverage_reader: async () => ({
      type: 'eligible',
      source_id: 'official_race_lap_timing',
      metric,
      coverage_query_id: 'official_event_coverage_v1',
      coverage_query_sha256: WP12_OFFICIAL_TIMING_ACTIVATION_BUNDLE.non_execution.coverage_queries[0].statement_sha256,
      query_calls: 1,
      driver_coverage: [
        { driver_id: 'max-verstappen', completed_laps: 44, eligible_laps: 40, excluded_deleted_laps: 2, excluded_pit_marker_laps: 2 },
        { driver_id: 'fernando-alonso', completed_laps: 44, eligible_laps: 41, excluded_deleted_laps: 1, excluded_pit_marker_laps: 2 }
      ]
    }) as never
  };
}

function releaseBinding(overrides: Partial<OfficialTimingReleaseBinding> = {}): OfficialTimingReleaseBinding {
  return {
    release_version: 9,
    release_id: 'test-release-9',
    commit_sha: 'a'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'test-deployment',
    expires_at: new Date(NOW + 300_000).toISOString(),
    routing_mode: 'compositional_profiles',
    allowed_capability_profile_ids: [OFFICIAL_TIMING_CAPABILITY_PROFILE_ID],
    allowed_principal_classes: ['internal', 'internal_canary', 'public'],
    catalog_hash: OFFICIAL_TIMING_CATALOG_V2_SHA256,
    release_attestation_sha256: 'b'.repeat(64),
    ...overrides
  };
}

async function chain(questionText = EVENT_MEAN_QUESTION) {
  const question = matched(questionText);
  const evidence = enumerateOfficialTimingEvidence(question, CATALOG_V2);
  const resolution = await collectOfficialTimingResolution(question, evidence, dependenciesFor(evidence.candidates[0].metric_id));
  const plan = planOfficialTimingAnswer({ question, evidence, resolution });
  const pipeline = runOfficialTimingPlannedPipeline(plan);
  const proof = proveOfficialTimingPlan({ question, evidence, resolution, plan, pipeline });
  return { question, evidence, resolution, plan, pipeline, proof };
}

function authorize(chainContext: Awaited<ReturnType<typeof chain>>, overrides: Record<string, unknown> = {}) {
  return authorizeOfficialTimingCapability({
    ...chainContext,
    request_id: 'request-1',
    principal_class: 'internal',
    canary: { stage: 100, subject_id: 'subject-1' },
    release: releaseBinding(),
    now_ms: NOW,
    ...overrides
  });
}

describe('official timing capability profile 34', () => {
  it('is byte-identical to the sealed target profile contract', () => {
    const registryContract = WP12_OFFICIAL_TIMING_SEMANTIC_TARGET.components.capability_registry.contract as any;
    expect(getOfficialTimingCapabilityProfileHash()).toBe(registryContract.added_profile_contract_sha256);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.version).toBe(OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.version).toBe(34);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.catalog_hash).toBe(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.generic_average_or_median_allowed).toBe(false);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.coverage_witness_required).toBe(true);
    expect(OFFICIAL_TIMING_CAPABILITY_PROFILE.complete_interactions).toHaveLength(2);
    expect(Object.isFrozen(OFFICIAL_TIMING_CAPABILITY_PROFILE)).toBe(true);
  });
});

describe('official timing capability authorization v34', () => {
  it('issues a fully bound one-time authorization', async () => {
    const context = await chain();
    const authorization = authorize(context);
    expect(authorization.version).toBe(OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_VERSION);
    expect(authorization.profile_id).toBe(OFFICIAL_TIMING_CAPABILITY_PROFILE_ID);
    expect(authorization.profile_version).toBe(34);
    expect(authorization.profile_hash).toBe(getOfficialTimingCapabilityProfileHash());
    expect(authorization.expires_at_ms).toBe(NOW + OFFICIAL_TIMING_AUTHORIZATION_TTL_MS);
    expect(authorization.catalog_hash).toBe(OFFICIAL_TIMING_CATALOG_V2_SHA256);
    expect(authorization.proof_hash).toBe(context.proof.proof_hash);
    expect(authorization.answer_plan_hash).toBe(context.plan.answer_plan_hash);
    expect(authorization.compiled_hash).toBe(context.pipeline.compiled.compiled_sha256);
    expect(authorization.coverage_witness_sha256).toBe(context.plan.coverage_witness_hash);
    expect(authorization.result_collection).toEqual({
      version: 'semantic-limit-plus-one-v1',
      returned_row_limit: 1,
      completeness_probe_rows: 0,
      observed_row_limit: 1
    });
    expect(authorization.authorization_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(authorization)).toBe(true);
  });

  it('caps expiry at release expiry', async () => {
    const context = await chain();
    const authorization = authorize(context, {
      release: releaseBinding({ expires_at: new Date(NOW + 1000).toISOString() })
    });
    expect(authorization.expires_at_ms).toBe(NOW + 1000);
  });

  it('rejects inactive routing, expired release, unlisted profile or principal, and catalog mismatch', async () => {
    const context = await chain();
    expect(() => authorize(context, { release: releaseBinding({ routing_mode: 'template_only' as never }) }))
      .toThrowError(expect.objectContaining({ reason: 'routing_mode_inactive' }));
    expect(() => authorize(context, { release: releaseBinding({ expires_at: new Date(NOW - 1).toISOString() }) }))
      .toThrowError(expect.objectContaining({ reason: 'release_inactive' }));
    expect(() => authorize(context, { release: releaseBinding({ release_version: 8 as never }) }))
      .toThrowError(expect.objectContaining({ reason: 'release_inactive' }));
    expect(() => authorize(context, { release: releaseBinding({ allowed_capability_profile_ids: [] }) }))
      .toThrowError(expect.objectContaining({ reason: 'profile_not_released' }));
    expect(() => authorize(context, { principal_class: 'public', release: releaseBinding({ allowed_principal_classes: ['internal'] }) }))
      .toThrowError(expect.objectContaining({ reason: 'profile_not_released' }));
    expect(() => authorize(context, { release: releaseBinding({ catalog_hash: '0'.repeat(64) }) }))
      .toThrowError(expect.objectContaining({ reason: 'catalog_mismatch' }));
  });

  it('rejects foreign proofs and malformed request context', async () => {
    const context = await chain();
    const other = await chain('Compare Max Verstappen and Fernando Alonso by official mean race lap time at the 2022 Belgian Grand Prix');
    expect(() => authorize(context, { proof: other.proof }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
    expect(() => authorize(context, { request_id: '' }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
    expect(() => authorize(context, { canary: { stage: 101, subject_id: 'subject-1' } }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
  });

  it('consumes exactly once with binding, expiry, and kill-switch enforcement', async () => {
    const context = await chain();
    const authorization = authorize(context);
    const consumed = consumeOfficialTimingCapabilityAuthorization(authorization, {
      request_id: 'request-1',
      principal_class: 'internal',
      is_kill_switch_active: () => false,
      now_ms: NOW + 100
    });
    expect(consumed).toBe(authorization);
    expect(() => consumeOfficialTimingCapabilityAuthorization(authorization, {
      request_id: 'request-1', principal_class: 'internal', is_kill_switch_active: () => false, now_ms: NOW + 100
    })).toThrowError(expect.objectContaining({ reason: 'authorization_replayed' }));
  });

  it('enforces the sealed canary stage set from the profile', async () => {
    const context = await chain();
    expect(() => authorize(context, { canary: { stage: 5, subject_id: 'subject-1' } }))
      .toThrowError(expect.objectContaining({ reason: 'profile_not_released' }));
    expect(() => authorize(context, { canary: { stage: 0, subject_id: 'subject-1' } }))
      .toThrowError(expect.objectContaining({ reason: 'profile_not_released' }));
  });

  it('rejects releases with empty identity fields', async () => {
    const context = await chain();
    expect(() => authorize(context, { release: releaseBinding({ release_id: '' }) }))
      .toThrowError(expect.objectContaining({ reason: 'release_inactive' }));
    expect(() => authorize(context, { release: releaseBinding({ audience: '' }) }))
      .toThrowError(expect.objectContaining({ reason: 'release_inactive' }));
  });

  it('meets the answer-authorization v28 contract expectations behaviorally', async () => {
    const target: any = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.answer_authorization_code.contract;
    // TTL: the implementation constant equals the sealed maximum and caps issuance.
    expect(OFFICIAL_TIMING_AUTHORIZATION_TTL_MS).toBe(target.authorization_ttl_ms_maximum);
    // Release attestation version: the implementation requires exactly the sealed target version.
    expect(target.release_attestation_version).toBe(9);
    const context = await chain();
    expect(() => authorize(context, { release: releaseBinding({ release_version: 8 as never }) }))
      .toThrowError(expect.objectContaining({ reason: 'release_inactive' }));
    // Release expiry caps authorization: issuance under an imminent release expiry shortens the token.
    const capped = authorize(context, { release: releaseBinding({ expires_at: new Date(NOW + 1000).toISOString() }) });
    expect(capped.expires_at_ms).toBe(NOW + 1000);
    // No authorization from a forged proof over a genuine chain.
    expect(() => authorize(context, { proof: structuredClone(context.proof) }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
  });

  it('rejects replay, wrong binding, expiry, and kill switch at consumption', async () => {
    const context = await chain();
    expect(() => consumeOfficialTimingCapabilityAuthorization(authorize(context), {
      request_id: 'other-request', principal_class: 'internal', is_kill_switch_active: () => false, now_ms: NOW + 100
    })).toThrowError(expect.objectContaining({ reason: 'authorization_binding_mismatch' }));
    expect(() => consumeOfficialTimingCapabilityAuthorization(authorize(context), {
      request_id: 'request-1', principal_class: 'public', is_kill_switch_active: () => false, now_ms: NOW + 100
    })).toThrowError(expect.objectContaining({ reason: 'authorization_binding_mismatch' }));
    expect(() => consumeOfficialTimingCapabilityAuthorization(authorize(context), {
      request_id: 'request-1', principal_class: 'internal', is_kill_switch_active: () => false, now_ms: NOW + OFFICIAL_TIMING_AUTHORIZATION_TTL_MS
    })).toThrowError(expect.objectContaining({ reason: 'authorization_expired' }));
    expect(() => consumeOfficialTimingCapabilityAuthorization(authorize(context), {
      request_id: 'request-1', principal_class: 'internal', is_kill_switch_active: () => true, now_ms: NOW + 100
    })).toThrowError(expect.objectContaining({ reason: 'kill_switch_active' }));
    expect(() => consumeOfficialTimingCapabilityAuthorization({}, {
      request_id: 'request-1', principal_class: 'internal', is_kill_switch_active: () => false
    })).toThrowError(OfficialTimingAuthorizationError);
  });
});
