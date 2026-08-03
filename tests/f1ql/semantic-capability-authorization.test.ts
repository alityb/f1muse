import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertSemanticCapabilityAuthorizationActive,
  authorizeSemanticPlanCapability,
  consumeSemanticCapabilityAuthorization,
  SemanticCapabilityAuthorizationError,
  verifySemanticCapabilityAuthorization
} from '../../src/f1ql/semantic-capability-authorization';
import {
  SEMANTIC_CAPABILITY_PROFILE_IDS,
  SEMANTIC_CAPABILITY_PROFILES,
  SEMANTIC_CAPABILITY_REGISTRY_HASH,
  SemanticCapabilityProfileId
} from '../../src/f1ql/semantic-capability-registry';
import { planSemanticAnswerFromResolution, SemanticDriverMention } from '../../src/f1ql/semantic-planner';
import { collectSemanticResolutionEvidence } from '../../src/f1ql/semantic-resolution-evidence';
import { proveSemanticAnswerPlan } from '../../src/f1ql/semantic-plan-proof';
import { admitSemanticQueryCandidates, enumerateSemanticQueries, SemanticLiteralSpan } from '../../src/f1ql/semantic-query';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import {
  ActiveAnswerReleaseContext,
  AnswerPrincipalClass,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationSigningPayload,
  verifyAnswerReleaseAttestation
} from '../../src/f1ql/answer-release-attestation';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const keyPair = generateKeyPairSync('ed25519');
const trustedKey = { key_id: 'semantic-capability-key', public_key: keyPair.publicKey };
const runtime = {
  max_concurrency: 2, queue_timeout_ms: 2_000, request_timeout_ms: 12_000, rate_limit_max: 10,
  rate_limit_window_ms: 900_000, statement_timeout_ms: 3_000, max_work_units: 200, max_rows: 100, max_response_bytes: 65_536
};
const hash = (digit: string) => digit.repeat(64);
const canary = (stage: 0 | 100 = 100, killSwitch = false) => ({
  stage, subject_id: 'semantic-capability-subject', kill_switch: killSwitch
});
const POSITIVE_PROPERTY_SEED = 20260731;
const POSITIVE_PROPERTY_RUNS = 40;

interface PositiveProfileInput {
  readonly year: number;
  readonly round: number;
  readonly candidate_count: number;
  readonly selected_index: number;
}

interface PositiveProfileCase {
  readonly question: string;
  readonly entity_names: readonly string[];
  readonly driver_mentions?: readonly {
    readonly name: string;
    readonly candidates: readonly string[];
    readonly active_candidates: readonly string[];
  }[];
}

type PositiveProfileFactory = (input: PositiveProfileInput) => PositiveProfileCase;

const POSITIVE_PROFILE_CASES = {
  'semantic-single-source-v1': [({ year }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and championship points from final ${year} driver standings.`,
    entity_names: []
  }), (input: PositiveProfileInput): PositiveProfileCase => ({
    question: 'What were Charles Leclerc final standings points in 2024?',
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', input.candidate_count, input.selected_index),
      active_candidates: ['charles-leclerc']
    }]
  })],
  'semantic-safe-dimension-join-v1': [({ year, round }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and finishing position, event name, and circuit identifier for round ${round} of final ${year} race classification and event metadata.`,
    entity_names: []
  })],
  'semantic-aggregate-locality-v1': [(input: PositiveProfileInput): PositiveProfileCase => ({
    question: `Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final ${input.year}.`,
    entity_names: ['Norris'],
    driver_mentions: [{
      name: 'Norris',
      candidates: candidateInventory('lando-norris', input.candidate_count, input.selected_index),
      active_candidates: ['lando-norris']
    }]
  })]
} satisfies Record<SemanticCapabilityProfileId, readonly PositiveProfileFactory[]>;

const positiveProfileInputArbitrary = fc.integer({ min: 1, max: 100 }).chain(candidateCount => fc.record({
  year: fc.integer({ min: 1950, max: 2025 }),
  round: fc.integer({ min: 1, max: 30 }),
  candidate_count: fc.constant(candidateCount),
  selected_index: fc.integer({ min: 0, max: candidateCount - 1 })
}));

describe('semantic complete-interaction capability authorization', () => {
  it('positively generates every current signed profile across bounded historical and resolver inputs', async () => {
    expect(Object.keys(POSITIVE_PROFILE_CASES).sort()).toEqual([...SEMANTIC_CAPABILITY_PROFILE_IDS].sort());
    for (const profile of SEMANTIC_CAPABILITY_PROFILES) {
      expect(profile.result_collection).toEqual({
        version: 'semantic-limit-plus-one-v1',
        completeness_probe_rows: profile.id === 'semantic-aggregate-locality-v1' ? 0 : 1
      });
      const factories = POSITIVE_PROFILE_CASES[profile.id];
      expect(factories).toHaveLength(profile.complete_interactions.length);
      const generatedInteractions = [];
      for (const factory of factories) {
        for (const principalClass of profile.principal_classes) {
          for (const boundary of [
            { year: 1950, round: 1, candidate_count: 1, selected_index: 0 },
            { year: 2025, round: 30, candidate_count: 100, selected_index: 99 }
          ]) {
            const authorization = await expectPositiveProfileAuthorization(
              profile.id, factory, principalClass, boundary
            );
            if (principalClass === profile.principal_classes[0] && boundary.year === 1950) {
              generatedInteractions.push(completeInteraction(authorization.interaction));
            }
          }
        }
        await fc.assert(fc.asyncProperty(
          positiveProfileInputArbitrary,
          async input => {
            for (const principalClass of profile.principal_classes) {
              await expectPositiveProfileAuthorization(profile.id, factory, principalClass, input);
            }
          }
        ), { seed: POSITIVE_PROPERTY_SEED, numRuns: POSITIVE_PROPERTY_RUNS });
      }
      expect(generatedInteractions.map(completeInteractionKey).sort())
        .toEqual(profile.complete_interactions.map(completeInteractionKey).sort());
    }
  });

  it('rejects latest-recorded 2026 data from a historical-final capability profile', async () => {
    const proof = await semanticProof(
      'List driver and championship points from latest recorded 2026 driver standings.', []
    );
    expect(() => authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
  });

  it('rejects a resolver inventory above the 100-candidate boundary', async () => {
    const question = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.';
    await expect(semanticProof(question, ['Norris'], [{
      name: 'Norris',
      candidates: candidateInventory('lando-norris', 101, 100),
      active_candidates: ['lando-norris']
    }])).rejects.toThrowError(expect.objectContaining({ reason: 'entity_inventory_mismatch' }));
  });

  it.each([
    ['List driver and championship points from final 2025 driver standings.', 'semantic-single-source-v1', []],
    ['Show the final 2025 standings points.', 'semantic-single-source-v1', []],
    ['What were the final standings points in 2025?', 'semantic-single-source-v1', []],
    ['What were Charles Leclerc final standings points in 2024?', 'semantic-single-source-v1', ['Charles Leclerc']],
    ['List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.', 'semantic-safe-dimension-join-v1', []],
    ['Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.', 'semantic-aggregate-locality-v1', ['Norris']]
  ] as const)('authorizes the entire proven interaction for %s', async (question, profileId, entityNames) => {
    const proof = await semanticProof(
      question,
      entityNames,
      question === 'What were Charles Leclerc final standings points in 2024?'
        ? [{ name: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] }]
        : undefined
    );
    const attestation = release({ deployment_capability_profile_ids: [profileId] });
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: profileId,
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: attestation,
      now_ms: NOW
    });
    expect(authorization).toMatchObject({
      profile_id: profileId,
      registry_hash: SEMANTIC_CAPABILITY_REGISTRY_HASH,
      catalog_hash: proof.catalog_hash,
      semantic_evidence_hash: proof.semantic_evidence_hash,
      candidate_set_hash: proof.candidate_set_hash,
      resolution_evidence_hash: proof.resolution_evidence_hash,
      answer_plan_hash: proof.answer_plan_hash,
      planned_f1ql_hash: proof.planned_f1ql_hash,
      core_hash: proof.core_hash,
      topology_hash: proof.topology_hash,
      semantic_plan_proof_hash: proof.proof_hash
    });
    const profile = SEMANTIC_CAPABILITY_PROFILES.find(item => item.id === profileId)!;
    expect(authorization.result_collection).toMatchObject({
      returned_row_limit: authorization.interaction.rows,
      completeness_probe_rows: profile.result_collection.completeness_probe_rows,
      observed_row_limit: authorization.interaction.rows + profile.result_collection.completeness_probe_rows
    });
    expect(authorization.capability_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(authorization.interaction)).toBe(true);
    expect(verifySemanticCapabilityAuthorization(authorization)).toBe(authorization);
    expect(() => verifySemanticCapabilityAuthorization({ ...authorization })).toThrow('invalid_authorization');
  });

  it('rejects valid components assembled into a profile not selected by the signed release', async () => {
    const joinProof = await semanticProof(
      'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.',
      []
    );
    const attestation = release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] });
    expect(() => authorizeSemanticPlanCapability({
      proof: joinProof,
      profile_id: 'semantic-safe-dimension-join-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(), canary: canary(),
      release_attestation: attestation,
      now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_not_released' }));
    expect(() => authorizeSemanticPlanCapability({
      proof: joinProof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(), canary: canary(),
      release_attestation: attestation,
      now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
  });

  it.each([
    [
      'List driver and championship position from final 2025 driver standings.',
      'semantic-single-source-v1'
    ],
    [
      'List driver and finishing position and event name for round 1 of final 2025 race classification and event metadata.',
      'semantic-safe-dimension-join-v1'
    ]
  ] as const)('rejects an unreviewed complete interaction despite individually allowed components', async (question, profileId) => {
    const proof = await semanticProof(question, []);
    const attestation = release({ deployment_capability_profile_ids: [profileId] });
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: profileId, principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(), release_attestation: attestation, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
  });

  it('binds singleton-filtered authorization to the reviewed question, season, and driver', async () => {
    const variants = [
      {
        question: 'List driver and championship points for Norris from final 2024 driver standings.',
        entities: ['Norris'],
        mentions: [{ name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] }]
      },
      {
        question: 'What were Charles Leclerc final standings points in 2024?',
        entities: ['Charles Leclerc'],
        mentions: [{ name: 'Charles Leclerc', candidates: ['lando-norris'], active_candidates: ['lando-norris'] }]
      }
    ];
    for (const variant of variants) {
      const proof = await semanticProof(variant.question, variant.entities, variant.mentions);
      expect(() => authorizeSemanticPlanCapability({
        proof,
        profile_id: 'semantic-single-source-v1',
        principal_class: 'internal_canary',
        request_id: randomUUID(),
        canary: canary(),
        release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
        now_ms: NOW
      })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
    }
  });

  it('rejects generated pairwise and higher-order combinations outside reviewed complete interactions', async () => {
    const variants = [
      {
        profileId: 'semantic-single-source-v1' as const,
        question: (year: number) => `List driver and championship position from final ${year} driver standings.`
      },
      {
        profileId: 'semantic-single-source-v1' as const,
        question: (year: number) => `List driver, championship points, and championship position from final ${year} driver standings.`
      },
      {
        profileId: 'semantic-safe-dimension-join-v1' as const,
        question: (year: number) => `List driver and finishing position and event name for round 1 of final ${year} race classification and event metadata.`
      },
      {
        profileId: 'semantic-safe-dimension-join-v1' as const,
        question: (year: number) => `List driver and finishing position and circuit identifier for round 1 of final ${year} race classification and event metadata.`
      },
      {
        profileId: 'semantic-aggregate-locality-v1' as const,
        question: (year: number) => `Show count of finishing position from race classification and count of qualifying position from qualifying classification in final ${year}.`
      }
    ];
    await fc.assert(fc.asyncProperty(
      fc.record({ year: fc.integer({ min: 1950, max: 2025 }), variant: fc.constantFrom(...variants) }),
      async ({ year, variant }) => {
        const proof = await semanticProof(variant.question(year), []);
        const attestation = release({ deployment_capability_profile_ids: [variant.profileId] });
        expect(() => authorizeSemanticPlanCapability({
          proof,
          profile_id: variant.profileId,
          principal_class: 'internal_canary',
          request_id: randomUUID(),
          canary: canary(),
          release_attestation: attestation,
          now_ms: NOW
        })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
      }
    ), { seed: 20260730, numRuns: 60 });
  });

  it.each(['template_only', 'shadow_compare'] as const)('does not issue compositional authority in %s mode', async answerRoutingMode => {
    const proof = await semanticProof('List driver and championship points from final 2025 driver standings.', []);
    const attestation = release({
      answer_routing_mode: answerRoutingMode,
      deployment_capability_profile_ids: answerRoutingMode === 'template_only' ? [] : ['semantic-single-source-v1']
    });
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(), release_attestation: attestation, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'routing_mode_inactive' }));
  });

  it('rejects copied proof, unapproved principal, and non-proof inputs', async () => {
    const proof = await semanticProof('List driver and championship points from final 2025 driver standings.', []);
    const attestation = release({
      deployment_capability_profile_ids: ['semantic-single-source-v1'],
      deployment_principal_classes: ['internal_canary', 'public']
    });
    const base = {
      profile_id: 'semantic-single-source-v1' as const, request_id: randomUUID(), canary: canary(),
      release_attestation: attestation, now_ms: NOW
    };
    expect(() => authorizeSemanticPlanCapability({ ...base, proof: { ...proof } as never, principal_class: 'internal_canary' }))
      .toThrow(SemanticCapabilityAuthorizationError);
    expect(() => authorizeSemanticPlanCapability({ ...base, proof: proof as never, principal_class: 'public' }))
      .toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
    expect(() => authorizeSemanticPlanCapability({ ...base, proof: { core_hash: proof.core_hash } as never, principal_class: 'internal_canary' }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
  });

  it('consumes once with live request, principal, canary, release, time, and kill-switch bindings', async () => {
    const proof = await semanticProof('List driver and championship points from final 2025 driver standings.', []);
    const attestation = release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] });
    const requestId = randomUUID();
    const authorization = authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: requestId,
      canary: canary(), release_attestation: attestation, now_ms: NOW
    });
    const context = {
      request_id: requestId, principal_class: 'internal_canary' as const, canary_stage: 100,
      canary_subject_id: canary().subject_id,
      audience: attestation.audience, deployment_id: attestation.deployment_id,
      release_attestation: attestation, is_kill_switch_active: () => false, now_ms: NOW + 1
    };
    expect(() => assertSemanticCapabilityAuthorizationActive(authorization, context))
      .toThrowError(expect.objectContaining({ reason: 'invalid_authorization' }));
    expect(consumeSemanticCapabilityAuthorization(authorization, context)).toBe(authorization);
    expect(assertSemanticCapabilityAuthorizationActive(authorization, context)).toBe(authorization);
    expect(() => assertSemanticCapabilityAuthorizationActive(authorization, {
      ...context, is_kill_switch_active: () => true
    })).toThrowError(expect.objectContaining({ reason: 'kill_switch_active' }));
    expect(() => consumeSemanticCapabilityAuthorization(authorization, context))
      .toThrowError(expect.objectContaining({ reason: 'authorization_replayed' }));
  });

  it('enforces profile canary policy, signed runtime ceilings, kill switch, expiry, and request binding', async () => {
    const proof = await semanticProof('List driver and championship points from final 2025 driver standings.', []);
    const standardRelease = release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] });
    const issue = (requestId = randomUUID()) => authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: requestId,
      canary: canary(), release_attestation: standardRelease, now_ms: NOW
    });
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(0), release_attestation: standardRelease, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(100, true), release_attestation: standardRelease, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'kill_switch_active' }));
    const boundedRelease = release({
      deployment_capability_profile_ids: ['semantic-single-source-v1'],
      runtime: { ...runtime, max_work_units: 1, max_rows: 1 }
    });
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: 'semantic-single-source-v1', principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(), release_attestation: boundedRelease, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
    const authorization = issue();
    const consumption = {
      request_id: randomUUID(), principal_class: 'internal_canary' as const, canary_stage: 100,
      canary_subject_id: canary().subject_id,
      audience: standardRelease.audience, deployment_id: standardRelease.deployment_id,
      release_attestation: standardRelease, is_kill_switch_active: () => false
    };
    expect(() => consumeSemanticCapabilityAuthorization(authorization, { ...consumption, now_ms: NOW + 1 }))
      .toThrowError(expect.objectContaining({ reason: 'authorization_binding_mismatch' }));
    expect(() => consumeSemanticCapabilityAuthorization(authorization, {
      ...consumption, request_id: authorization.request_id, now_ms: authorization.expires_at_ms
    })).toThrowError(expect.objectContaining({ reason: 'authorization_expired' }));
  });
});

async function semanticProof(
  question: string,
  entityNames: readonly string[],
  driverMentions?: PositiveProfileCase['driver_mentions']
) {
  return (await semanticArtifacts(question, entityNames, driverMentions)).proof;
}

async function semanticArtifacts(
  question: string,
  entityNames: readonly string[],
  driverMentions?: PositiveProfileCase['driver_mentions']
) {
  const entities = entityNames.map(name => ({ type: 'driver' as const, span: span(question, name) }));
  const evidence = enumerateSemanticQueries(question, entities);
  if (evidence.type !== 'candidate_set') throw new Error('test evidence was not a candidate set');
  const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, question, evidence);
  if (admission.type !== 'admitted') throw new Error('test query was not admitted');
  const mentions: SemanticDriverMention[] = entityNames.map(name => ({
    ...span(question, name),
    candidates: driverMentions?.find(mention => mention.name === name)?.candidates ?? ['lando-norris'],
    active_candidates: driverMentions?.find(mention => mention.name === name)?.active_candidates ?? ['lando-norris']
  }));
  const year = Number(/\b(?:19|20)\d{2}\b/u.exec(question)?.[0] ?? 2025);
  const round = Number(/\bround\s+(\d{1,2})\b/iu.exec(question)?.[1] ?? 1);
  const resolution = await collectSemanticResolutionEvidence({
    question,
    admission,
    driver_resolver: { inventoryMentions: async () => mentions },
    event_resolver: {
      resolve: async () => ({ type: 'resolved', season: year, round }),
      resolveRound: async () => ({ type: 'resolved', season: year, round })
    }
  });
  const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
  const proof = proveSemanticAnswerPlan({ question, entity_inventory: entities, evidence, admission, resolution, plan });
  return { proof, resolution };
}

function release(overrides: Partial<ActiveAnswerReleaseContext> = {}) {
  const context: ActiveAnswerReleaseContext = {
    release_id: 'semantic-capability-release',
    issued_at: '2026-07-30T11:59:00.000Z',
    expires_at: '2026-07-30T12:09:00.000Z',
    commit_sha: 'e'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'semantic-capability-deployment',
    canary_policy_version: 'answer-canary-hmac-v1',
    maximum_canary_stage: 100,
    canary_hmac_key_sha256: hash('7'),
    evidence_hashes: {
      manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
      result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d'),
      semantic_catalog_hash: SEMANTIC_CATALOG_HASH, semantic_catalog_database_binding_hash: hash('f'), semantic_catalog_binding_artifact_sha256: hash('0')
    },
    statuses: { semantic: 'pass', safety: 'pass', linker: 'pass' },
    runtime,
    deployment_template_ids: ['final_standings_leader'],
    answer_routing_mode: 'compositional_profiles',
    deployment_capability_profile_ids: ['semantic-single-source-v1'],
    migrated_template_ids: [],
    deployment_principal_classes: ['internal_canary'],
    ...overrides
  };
  const unsigned = {
    version: 8 as const,
    kind: 'f1ql_answer_release_attestation' as const,
    key_id: trustedKey.key_id,
    ...buildActiveAnswerReleaseBindings(context)
  };
  return verifyAnswerReleaseAttestation({
    ...unsigned,
    signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), keyPair.privateKey).toString('base64')
  }, trustedKey, context, { now_ms: NOW, max_validity_ms: 600_000, max_age_ms: 300_000 });
}

function span(question: string, text: string): SemanticLiteralSpan {
  const points = Array.from(question);
  const target = Array.from(text);
  const start = points.findIndex((_point, index) => target.every((point, offset) => points[index + offset] === point));
  if (start < 0) throw new Error(`missing test span ${text}`);
  return { text, start, end: start + target.length };
}

async function expectPositiveProfileAuthorization(
  profileId: SemanticCapabilityProfileId,
  factory: PositiveProfileFactory,
  principalClass: AnswerPrincipalClass,
  input: PositiveProfileInput
) {
  const testCase = factory(input);
  const { proof, resolution } = await semanticArtifacts(
    testCase.question, testCase.entity_names, testCase.driver_mentions
  );
  if (testCase.driver_mentions) {
    const mention = testCase.driver_mentions[0];
    expect(resolution.resolver_candidates).toBe(input.candidate_count);
    expect(resolution.entities[0].candidate_ids).toEqual([...mention.candidates].sort());
    expect(resolution.entities[0].selected_id).toBe(mention.active_candidates[0]);
  }
  const authorization = authorizeSemanticPlanCapability({
    proof,
    profile_id: profileId,
    principal_class: principalClass,
    request_id: randomUUID(),
    canary: canary(),
    release_attestation: release({
      deployment_capability_profile_ids: [profileId],
      deployment_principal_classes: [principalClass]
    }),
    now_ms: NOW
  });
  expect(authorization).toMatchObject({
    profile_id: profileId,
    registry_hash: SEMANTIC_CAPABILITY_REGISTRY_HASH,
    catalog_hash: proof.catalog_hash,
    semantic_evidence_hash: proof.semantic_evidence_hash,
    candidate_set_hash: proof.candidate_set_hash,
    resolution_evidence_hash: proof.resolution_evidence_hash,
    answer_plan_hash: proof.answer_plan_hash,
    planned_f1ql_hash: proof.planned_f1ql_hash,
    core_hash: proof.core_hash,
    topology_hash: proof.topology_hash,
    semantic_plan_proof_hash: proof.proof_hash
  });
  const profile = SEMANTIC_CAPABILITY_PROFILES.find(item => item.id === profileId)!;
  expect(authorization.result_collection).toMatchObject({
    version: profile.result_collection.version,
    returned_row_limit: authorization.interaction.rows,
    completeness_probe_rows: profile.result_collection.completeness_probe_rows,
    observed_row_limit: authorization.interaction.rows + profile.result_collection.completeness_probe_rows,
    compiled_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(authorization.result_collection.returned_row_limit).toBeLessThanOrEqual(runtime.max_rows);
  expect(authorization.capability_hash).toMatch(/^[a-f0-9]{64}$/u);
  expectDeepFrozen(authorization.interaction);
  expect(verifySemanticCapabilityAuthorization(authorization)).toBe(authorization);
  return authorization;
}

function completeInteraction(interaction: {
  readonly predicate_bindings: readonly string[];
  readonly aggregate_bindings: readonly string[];
  readonly group_bindings: readonly string[];
  readonly output_bindings: readonly string[];
  readonly sort_bindings: readonly string[];
  readonly rows: number;
}) {
  return {
    predicate_bindings: interaction.predicate_bindings,
    aggregate_bindings: interaction.aggregate_bindings,
    group_bindings: interaction.group_bindings,
    output_bindings: interaction.output_bindings,
    sort_bindings: interaction.sort_bindings,
    requested_rows: interaction.rows
  };
}

function completeInteractionKey(interaction: {
  readonly predicate_bindings: readonly string[];
  readonly aggregate_bindings: readonly string[];
  readonly group_bindings: readonly string[];
  readonly output_bindings: readonly string[];
  readonly sort_bindings: readonly string[];
  readonly requested_rows: number;
}): string {
  return JSON.stringify([
    interaction.predicate_bindings,
    interaction.aggregate_bindings,
    interaction.group_bindings,
    interaction.output_bindings,
    interaction.sort_bindings,
    interaction.requested_rows
  ]);
}

function candidateInventory(selectedId: string, count: number, selectedIndex: number): string[] {
  return [
    ...Array.from({ length: selectedIndex }, (_, index) => `a-candidate-${String(index).padStart(3, '0')}`),
    selectedId,
    ...Array.from({ length: count - selectedIndex - 1 }, (_, index) => `z-candidate-${String(index).padStart(3, '0')}`)
  ];
}

function expectDeepFrozen(value: unknown): void {
  if (!value || typeof value !== 'object') {return;}
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {expectDeepFrozen(child);}
}
