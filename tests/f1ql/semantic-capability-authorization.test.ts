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
  }), ({ year, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and championship points for Charles Leclerc from final ${year} driver standings.`,
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', candidate_count, selected_index),
      active_candidates: ['charles-leclerc']
    }]
  }), ({ year, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and championship position for Charles Leclerc from final ${year} driver standings.`,
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', candidate_count, selected_index),
      active_candidates: ['charles-leclerc']
    }]
  }), ({ year, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver, championship position, and championship points for Charles Leclerc from final ${year} driver standings.`,
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', candidate_count, selected_index),
      active_candidates: ['charles-leclerc']
    }]
  }), ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, 2 + (round % 3));
    return {
      question: `List driver and championship position for ${drivers.map(([name]) => name).join(', ')} from final ${year} driver standings.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, 2 + (round % 3));
    return {
      question: `List driver, championship position, and championship points for ${drivers.map(([name]) => name).join(', ')} from final ${year} driver standings.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, 2 + (round % 3));
    return {
      question: `List driver and championship points for ${drivers.map(([name]) => name).join(', ')} from final ${year} driver standings.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, 2 + (round % 3));
    return {
      question: `Rank ${drivers.map(([name]) => name).join(', ')} by championship position in final ${year} driver standings.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List race date from round ${round} of final ${year} event metadata.`,
    entity_names: []
  }), ({ year, round }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List circuit identifier from round ${round} of final ${year} event metadata.`,
    entity_names: []
  }), ({ year, round }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List event name from round ${round} of final ${year} event metadata.`,
    entity_names: []
  }), ({ year, round }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List race date and event name from round ${round} of final ${year} event metadata.`,
    entity_names: []
  }), ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and finishing position for Charles Leclerc from round ${round} of final ${year} race classification.`,
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', candidate_count, selected_index),
      active_candidates: ['charles-leclerc']
    }]
  }), ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, 2 + (round % 3));
    return {
      question: `List driver and finishing position for ${drivers.map(([name]) => name).join(', ')} from round ${round} of final ${year} race classification.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, 2 + (round % 3));
    return {
      question: `Rank drivers ${drivers.map(([name]) => name).join(', ')} by finishing position from round ${round} of final ${year} race classification.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year }: PositiveProfileInput): PositiveProfileCase => ({
    question: `Show count of finishing position in final ${year} race classification.`,
    entity_names: []
  }), ({ year, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `Show count of finishing position for Lando Norris in final ${year} race classification.`,
    entity_names: ['Lando Norris'],
    driver_mentions: [{
      name: 'Lando Norris',
      candidates: candidateInventory('lando-norris', candidate_count, selected_index),
      active_candidates: ['lando-norris']
    }]
  }), ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `List driver and qualifying position for Charles Leclerc from round ${round} of final ${year} qualifying classification.`,
    entity_names: ['Charles Leclerc'],
    driver_mentions: [{
      name: 'Charles Leclerc',
      candidates: candidateInventory('charles-leclerc', candidate_count, selected_index),
      active_candidates: ['charles-leclerc']
    }]
  }), ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, 2 + (round % 3));
    return {
      question: `List driver and qualifying position for ${drivers.map(([name]) => name).join(', ')} from round ${round} of final ${year} qualifying classification.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year, round, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, 2 + (round % 3));
    return {
      question: `Rank drivers ${drivers.map(([name]) => name).join(', ')} by qualifying position from round ${round} of final ${year} qualifying classification.`,
      entity_names: drivers.map(([name]) => name),
      driver_mentions: drivers.map(([name, id]) => ({
        name,
        candidates: candidateInventory(id, candidate_count, selected_index),
        active_candidates: [id]
      }))
    };
  }, ({ year }: PositiveProfileInput): PositiveProfileCase => ({
    question: `Show count of qualifying position in final ${year} qualifying classification.`,
    entity_names: []
  }), ({ year, candidate_count, selected_index }: PositiveProfileInput): PositiveProfileCase => ({
    question: `Show count of qualifying position for Lando Norris in final ${year} qualifying classification.`,
    entity_names: ['Lando Norris'],
    driver_mentions: [{
      name: 'Lando Norris',
      candidates: candidateInventory('lando-norris', candidate_count, selected_index),
      active_candidates: ['lando-norris']
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

const positiveProfileInputArbitrary = fc.integer({ min: 1, max: 50 }).chain(candidateCount => fc.record({
  year: fc.integer({ min: 1950, max: 2025 }),
  round: fc.integer({ min: 1, max: 30 }),
  candidate_count: fc.constant(candidateCount),
  selected_index: fc.integer({ min: 0, max: candidateCount - 1 })
}));

describe('semantic complete-interaction capability authorization', () => {
  it('defines single-source selections as structural cardinality families without static question or identity allowlists', () => {
    const profile = SEMANTIC_CAPABILITY_PROFILES.find(item => item.id === 'semantic-single-source-v1')!;
    expect(profile.complete_interactions.map(interaction => interaction.entity_count)).toEqual([
      { min: 0, max: 0 },
      { min: 1, max: 1 },
      { min: 1, max: 1 },
      { min: 1, max: 1 },
      { min: 2, max: 4 },
      { min: 2, max: 4 },
      { min: 2, max: 4 },
      { min: 2, max: 4 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 1, max: 1 },
      { min: 2, max: 4 },
      { min: 2, max: 4 },
      { min: 0, max: 0 },
      { min: 1, max: 1 },
      { min: 1, max: 1 },
      { min: 2, max: 4 },
      { min: 2, max: 4 },
      { min: 0, max: 0 },
      { min: 1, max: 1 }
    ]);
    expect(profile.source_sets).toEqual([
      ['driver_standings'], ['event_classification'], ['event_metadata'], ['qualifying_classification']
    ]);
    expect(profile.limits).toMatchObject({ entities: 4, events: 1, seasons: 1 });
    expect(profile.complete_interactions.every(interaction =>
      !('question_sha256' in interaction) && !('season_values' in interaction) && !('entity_values' in interaction)
    )).toBe(true);
    expect(profile.scope).toBe('historical_final');
    expect(profile.complete_interactions.filter(interaction =>
      interaction.predicate_bindings.includes('event_metadata.season:eq')
    )).toEqual([
      {
        entity_count: { min: 0, max: 0 },
        predicate_bindings: ['event_metadata.round:eq', 'event_metadata.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: ['concept:event_metadata.date->date'],
        sort_bindings: ['date:asc:last'],
        requested_rows: 1
      },
      {
        entity_count: { min: 0, max: 0 },
        predicate_bindings: ['event_metadata.round:eq', 'event_metadata.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: ['concept:event_metadata.circuit_id->circuit_id'],
        sort_bindings: ['circuit_id:asc:last'],
        requested_rows: 1
      },
      {
        entity_count: { min: 0, max: 0 },
        predicate_bindings: ['event_metadata.round:eq', 'event_metadata.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: ['concept:event_metadata.event_name->event_name'],
        sort_bindings: ['event_name:asc:last'],
        requested_rows: 1
      },
      {
        entity_count: { min: 0, max: 0 },
        predicate_bindings: ['event_metadata.round:eq', 'event_metadata.season:eq'],
        aggregate_bindings: [],
        group_bindings: [],
        output_bindings: [
          'concept:event_metadata.date->date',
          'concept:event_metadata.event_name->event_name'
        ],
        sort_bindings: ['date:asc:last'],
        requested_rows: 1
      }
    ]);
  });

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
  }, 120_000);

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

  it('rejects latest-recorded 2026 race classification from the historical-final profile', async () => {
    const proof = await semanticProof(
      'List driver and finishing position from round 1 of latest recorded 2026 race classification.', []
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

  it('rejects latest-recorded 2026 qualifying classification from the historical-final profile', async () => {
    const proof = await semanticProof(
      'List driver and qualifying position from round 1 of latest recorded 2026 qualifying classification.', []
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

  it.each([
    'List race date from round 1 of latest recorded 2026 event metadata.',
    'List circuit identifier from round 1 of latest recorded 2026 event metadata.',
    'List event name from round 1 of latest recorded 2026 event metadata.',
    'List race date and event name from round 1 of latest recorded 2026 event metadata.'
  ])('rejects latest-recorded 2026 event metadata before capability authorization: %s', question => {
    expect(enumerateSemanticQueries(question)).toMatchObject({
      type: 'abstention', reason: 'unsupported_scope'
    });
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
    ['Final 2025 standings points for Lando Norris and Oscar Piastri.', 'semantic-single-source-v1', ['Lando Norris', 'Oscar Piastri']],
    ['Final 2025 standings points for Oscar Piastri and Lando Norris.', 'semantic-single-source-v1', ['Oscar Piastri', 'Lando Norris']],
    ['List race date from round 1 of final 2025 event metadata.', 'semantic-single-source-v1', []],
    ['List circuit identifier from round 1 of final 2025 event metadata.', 'semantic-single-source-v1', []],
    ['List event name from round 1 of final 2025 event metadata.', 'semantic-single-source-v1', []],
    ['List race date and event name from round 1 of final 2025 event metadata.', 'semantic-single-source-v1', []],
    ['Show count of finishing position in final 2025 race classification.', 'semantic-single-source-v1', []],
    ['Show count of finishing position for Norris in final 2025 race classification.', 'semantic-single-source-v1', ['Norris']],
    ['Show count of qualifying position in final 2025 qualifying classification.', 'semantic-single-source-v1', []],
    ['List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.', 'semantic-safe-dimension-join-v1', []],
    ['Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.', 'semantic-aggregate-locality-v1', ['Norris']]
  ] as const)('authorizes the entire proven interaction for %s', async (question, profileId, entityNames) => {
    const proof = await semanticProof(
      question,
      entityNames,
      question === 'What were Charles Leclerc final standings points in 2024?'
        ? [{ name: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] }]
        : question === 'Final 2025 standings points for Lando Norris and Oscar Piastri.'
          ? [
              { name: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
              { name: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
            ]
        : question === 'Final 2025 standings points for Oscar Piastri and Lando Norris.'
          ? [
              { name: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] },
              { name: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] }
            ]
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

  it('binds only the exact ungrouped recorded qualifying-position count interaction', async () => {
    const question = 'Show count of qualifying position in final 2025 qualifying classification.';
    const proof = await semanticProof(question, []);
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_aggregate',
      source_ids: ['qualifying_classification'],
      relationship_ids: [],
      operator_signature: 'limit(sort(project(aggregate(filter(source)))))',
      predicate_bindings: ['qualifying_classification.season:eq'],
      aggregate_bindings: [
        'qualifying_classification.qualifying_position:count->count_qualifying_position'
      ],
      group_bindings: [],
      output_bindings: ['aggregate:count_qualifying_position->count_qualifying_position'],
      sort_bindings: ['count_qualifying_position:asc:last'],
      entity_count: 0,
      event_count: 0,
      season_count: 1,
      season_values: [2025],
      rows: 1
    });
  });

  it('binds only the exact ungrouped recorded race-finishing-position count interaction', async () => {
    const question = 'Show count of finishing position in final 2025 race classification.';
    const proof = await semanticProof(question, []);
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_aggregate',
      source_ids: ['event_classification'],
      relationship_ids: [],
      operator_signature: 'limit(sort(project(aggregate(filter(source)))))',
      predicate_bindings: ['event_classification.season:eq'],
      aggregate_bindings: [
        'event_classification.finishing_position:count->count_finishing_position'
      ],
      group_bindings: [],
      output_bindings: ['aggregate:count_finishing_position->count_finishing_position'],
      sort_bindings: ['count_finishing_position:asc:last'],
      entity_count: 0,
      event_count: 0,
      season_count: 1,
      season_values: [2025],
      rows: 1
    });
  });

  it('binds only one resolved driver to the filtered race-position scalar count', async () => {
    const filteredQuestion = 'Show count of finishing position for Norris in final 2025 race classification.';
    const filteredProof = await semanticProof(filteredQuestion, ['Norris'], [{
      name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    const authorization = authorizeSemanticPlanCapability({
      proof: filteredProof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_aggregate',
      source_ids: ['event_classification'],
      relationship_ids: [],
      operator_signature: 'limit(sort(project(aggregate(filter(source)))))',
      predicate_bindings: [
        'event_classification.driver_id:eq',
        'event_classification.season:eq'
      ],
      aggregate_bindings: [
        'event_classification.finishing_position:count->count_finishing_position'
      ],
      group_bindings: [],
      output_bindings: ['aggregate:count_finishing_position->count_finishing_position'],
      sort_bindings: ['count_finishing_position:asc:last'],
      entity_count: 1,
      entity_values: ['lando-norris'],
      event_count: 0,
      season_count: 1,
      season_values: [2025],
      rows: 1
    });
  });

  it('binds only one resolved driver to the filtered qualifying-position scalar count', async () => {
    const question = 'Show count of qualifying position for Norris in final 2025 qualifying classification.';
    const proof = await semanticProof(question, ['Norris'], [{
      name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_aggregate',
      source_ids: ['qualifying_classification'],
      relationship_ids: [],
      operator_signature: 'limit(sort(project(aggregate(filter(source)))))',
      predicate_bindings: [
        'qualifying_classification.driver_id:eq',
        'qualifying_classification.season:eq'
      ],
      aggregate_bindings: [
        'qualifying_classification.qualifying_position:count->count_qualifying_position'
      ],
      group_bindings: [],
      output_bindings: ['aggregate:count_qualifying_position->count_qualifying_position'],
      sort_bindings: ['count_qualifying_position:asc:last'],
      entity_count: 1,
      entity_values: ['lando-norris'],
      event_count: 0,
      season_count: 1,
      season_values: [2025],
      rows: 1
    });
  });

  it('rejects latest-recorded and multi-driver classification-position counts', async () => {
    const latestProof = await semanticProof(
      'Show count of finishing position in latest recorded 2026 race classification.', []
    );
    const multiDriverRaceProof = await semanticProof(
      'Show count of finishing position for Lando Norris and Oscar Piastri in final 2025 race classification.',
      ['Lando Norris', 'Oscar Piastri'],
      [
        { name: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { name: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ]
    );
    const multiDriverQualifyingProof = await semanticProof(
      'Show count of qualifying position for Lando Norris and Oscar Piastri in final 2025 qualifying classification.',
      ['Lando Norris', 'Oscar Piastri'],
      [
        { name: 'Lando Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] },
        { name: 'Oscar Piastri', candidates: ['oscar-piastri'], active_candidates: ['oscar-piastri'] }
      ]
    );
    const attestation = release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] });
    for (const proof of [latestProof, multiDriverRaceProof, multiDriverQualifyingProof]) {
      expect(() => authorizeSemanticPlanCapability({
        proof,
        profile_id: 'semantic-single-source-v1',
        principal_class: 'internal_canary',
        request_id: randomUUID(),
        canary: canary(),
        release_attestation: attestation,
        now_ms: NOW
      })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
    }
  });

  it.each([
    'List race date from final 2025 event metadata at Monaco.',
    'List circuit identifier from final 2025 event metadata at Monaco.',
    'List event name from final 2025 event metadata at Monaco.',
    'List race date and event name from final 2025 event metadata at Monaco.'
  ])('authorizes a uniquely resolved named-event metadata interaction: %s', async question => {
    const proof = await semanticProof(
      question, [], undefined, ['Monaco']
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization).toMatchObject({
      profile_id: 'semantic-single-source-v1',
      semantic_plan_proof_hash: proof.proof_hash
    });
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
    ],
    [
      'List driver, finishing position, and race classification status from round 1 of final 2025 race classification.',
      'semantic-single-source-v1'
    ],
    [
      'List driver, qualifying position, and qualifying classification status from round 1 of final 2025 qualifying classification.',
      'semantic-single-source-v1'
    ]
  ] as const)('rejects an unreviewed complete interaction despite individually allowed components', async (question, profileId) => {
    const proof = await semanticProof(question, []);
    const attestation = release({ deployment_capability_profile_ids: [profileId] });
    expect(() => authorizeSemanticPlanCapability({
      proof, profile_id: profileId, principal_class: 'internal_canary', request_id: randomUUID(),
      canary: canary(), release_attestation: attestation, now_ms: NOW
    })).toThrowError(expect.objectContaining({ reason: 'profile_rejected' }));
  });

  it('authorizes singleton-filtered standings points by structure across final seasons and identities', async () => {
    const variants = [
      {
        question: 'List driver and championship points for Norris from final 2024 driver standings.',
        entities: ['Norris'],
        mentions: [{ name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] }]
      },
      {
        question: 'List driver and championship points for Giuseppe Farina from final 1950 driver standings.',
        entities: ['Giuseppe Farina'],
        mentions: [{ name: 'Giuseppe Farina', candidates: ['giuseppe-farina'], active_candidates: ['giuseppe-farina'] }]
      }
    ];
    for (const variant of variants) {
      const proof = await semanticProof(variant.question, variant.entities, variant.mentions);
      const authorization = authorizeSemanticPlanCapability({
        proof,
        profile_id: 'semantic-single-source-v1',
        principal_class: 'internal_canary',
        request_id: randomUUID(),
        canary: canary(),
        release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
        now_ms: NOW
      });
      expect(authorization.interaction).toMatchObject({
        entity_count: 1,
        predicate_bindings: ['driver_standings.driver_id:eq', 'driver_standings.season:eq']
      });
    }
  });

  it('binds only one resolved driver to the final standings-position selection', async () => {
    const question = 'List driver and championship position for Norris from final 2025 driver standings.';
    const proof = await semanticProof(question, ['Norris'], [{
      name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris']
    }]);
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_rows',
      source_ids: ['driver_standings'],
      relationship_ids: [],
      operator_signature: 'limit(sort(project(filter(source))))',
      predicate_bindings: ['driver_standings.driver_id:eq', 'driver_standings.season:eq'],
      aggregate_bindings: [],
      group_bindings: [],
      output_bindings: [
        'concept:driver_standings.driver_id->driver_id',
        'concept:driver_standings.championship_position->championship_position'
      ],
      sort_bindings: ['driver_id:asc:last'],
      entity_count: 1,
      entity_values: ['lando-norris'],
      event_count: 0,
      season_count: 1,
      season_values: [2025],
      rows: 1
    });
  });

  it.each([2, 3, 4] as const)('authorizes non-ranking standings-position selection through driver cardinality %i', async cardinality => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, cardinality);
    const question = `List driver and championship position for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_rows',
      predicate_bindings: ['driver_standings.driver_id:in', 'driver_standings.season:eq'],
      output_bindings: [
        'concept:driver_standings.driver_id->driver_id',
        'concept:driver_standings.championship_position->championship_position'
      ],
      sort_bindings: ['driver_id:asc:last'],
      entity_count: cardinality,
      rows: 100
    });
  });

  it('authorizes the singleton standings-position and points projection', async () => {
    const question = 'List driver, championship position, and championship points for Norris from final 2025 driver standings.';
    const proof = await semanticProof(
      question,
      ['Norris'],
      [{ name: 'Norris', candidates: ['lando-norris'], active_candidates: ['lando-norris'] }]
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      predicate_bindings: ['driver_standings.driver_id:eq', 'driver_standings.season:eq'],
      output_bindings: [
        'concept:driver_standings.driver_id->driver_id',
        'concept:driver_standings.championship_position->championship_position',
        'concept:driver_standings.points->points'
      ],
      entity_count: 1,
      rows: 1
    });
  });

  it.each([2, 3, 4] as const)('authorizes standings-position and points selection through driver cardinality %i', async cardinality => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, cardinality);
    const question = `List driver, championship position, and championship points for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      predicate_bindings: ['driver_standings.driver_id:in', 'driver_standings.season:eq'],
      output_bindings: [
        'concept:driver_standings.driver_id->driver_id',
        'concept:driver_standings.championship_position->championship_position',
        'concept:driver_standings.points->points'
      ],
      entity_count: cardinality,
      rows: 100
    });
  });

  it('authorizes reordered standings summary language through canonical output bindings', async () => {
    const question = 'List championship points, driver, and championship position for Lando Norris and Oscar Piastri from final 2025 driver standings.';
    const drivers = [
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ];
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    expect(authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    }).interaction.output_bindings).toEqual([
      'concept:driver_standings.driver_id->driver_id',
      'concept:driver_standings.championship_position->championship_position',
      'concept:driver_standings.points->points'
    ]);
  });

  it('rejects an unfiltered standings-position and points projection', async () => {
    const question = 'List driver, championship position, and championship points from final 2025 driver standings.';
    const mentions: readonly SemanticDriverMention[] = [];
    const proof = await semanticProof(question, mentions.map(mention => mention.name), mentions);
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

  it.each([2, 3, 4] as const)('authorizes exact resolved driver sets through cardinality %i', async cardinality => {
    const drivers = [
      ['Max Verstappen', 'max-verstappen'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri'],
      ['George Russell', 'george-russell']
    ].slice(0, cardinality);
    const question = `List driver and championship points for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    const authorization = authorizeSemanticPlanCapability({
        proof,
        profile_id: 'semantic-single-source-v1',
        principal_class: 'internal_canary',
        request_id: randomUUID(),
        canary: canary(),
        release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
        now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      entity_count: cardinality,
      predicate_bindings: ['driver_standings.driver_id:in', 'driver_standings.season:eq']
    });
  });

  it.each([1, 2, 3, 4] as const)('authorizes one-event race classification through driver cardinality %i', async cardinality => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, cardinality);
    const question = `List driver and finishing position for ${drivers.map(([name]) => name).join(', ')} from round 30 of final 2025 race classification.`;
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_rows',
      source_ids: ['event_classification'],
      entity_count: cardinality,
      event_count: 1,
      season_count: 1,
      season_values: [2025],
      output_bindings: [
        'concept:event_classification.driver_id->driver_id',
        'concept:event_classification.finishing_position->finishing_position'
      ],
      sort_bindings: ['driver_id:asc:last'],
      rows: cardinality === 1 ? 1 : 100
    });
    expect(authorization.interaction.predicate_bindings).toEqual([
      `event_classification.driver_id:${cardinality === 1 ? 'eq' : 'in'}`,
      'event_classification.round:eq',
      'event_classification.season:eq'
    ]);
  });

  it.each([1, 2, 3, 4] as const)('authorizes one-event qualifying classification through driver cardinality %i', async cardinality => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Oscar Piastri', 'oscar-piastri']
    ].slice(0, cardinality);
    const question = `List driver and qualifying position for ${drivers.map(([name]) => name).join(', ')} from round 30 of final 2025 qualifying classification.`;
    const proof = await semanticProof(
      question,
      drivers.map(([name]) => name),
      drivers.map(([name, id]) => ({ name, candidates: [id], active_candidates: [id] }))
    );
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      topology: 'single_source_rows',
      source_ids: ['qualifying_classification'],
      entity_count: cardinality,
      event_count: 1,
      season_count: 1,
      season_values: [2025],
      output_bindings: [
        'concept:qualifying_classification.driver_id->driver_id',
        'concept:qualifying_classification.qualifying_position->qualifying_position'
      ],
      sort_bindings: ['driver_id:asc:last'],
      rows: cardinality === 1 ? 1 : 100
    });
    expect(authorization.interaction.predicate_bindings).toEqual([
      `qualifying_classification.driver_id:${cardinality === 1 ? 'eq' : 'in'}`,
      'qualifying_classification.round:eq',
      'qualifying_classification.season:eq'
    ]);
  });

  it('rejects an unfiltered event selection without an event-complete coverage witness', async () => {
    const proof = await semanticProof(
      'List driver and finishing position from round 1 of final 2025 race classification.', []
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

  it('rejects an unfiltered qualifying selection without an event-complete coverage witness', async () => {
    const proof = await semanticProof(
      'List driver and qualifying position from round 1 of final 2025 qualifying classification.', []
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

  it('authorizes the same one-event interaction after unique named-event resolution', async () => {
    const question = 'List driver and finishing position for Charles Leclerc from final 2025 race classification at Monaco.';
    const charles = span(question, 'Charles Leclerc');
    const entities = [
      { type: 'driver' as const, span: charles },
      { type: 'event' as const, span: span(question, 'Monaco') }
    ];
    const evidence = enumerateSemanticQueries(question, entities);
    if (evidence.type !== 'candidate_set') throw new Error('named-event evidence was not a candidate set');
    const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, question, evidence);
    if (admission.type !== 'admitted') throw new Error('named-event query was not admitted');
    const resolution = await collectSemanticResolutionEvidence({
      question,
      admission,
      driver_resolver: {
        inventoryMentions: async () => [{
          ...charles, candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc']
        }]
      },
      event_resolver: {
        resolve: async () => ({ type: 'resolved', season: 2025, round: 8 }),
        resolveRound: async () => ({ type: 'missing' })
      }
    });
    const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
    const proof = proveSemanticAnswerPlan({ question, entity_inventory: entities, evidence, admission, resolution, plan });
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      source_ids: ['event_classification'], event_count: 1, season_count: 1, entity_count: 1
    });
    expect(resolution.entities).toMatchObject([
      { type: 'driver', selected_id: 'charles-leclerc' },
      { type: 'event', selected_id: 'event:2025:8' }
    ]);
  });

  it('authorizes qualifying selection after unique named-event resolution', async () => {
    const question = 'List driver and qualifying position for Charles Leclerc from final 2025 qualifying classification at Monaco.';
    const charles = span(question, 'Charles Leclerc');
    const entities = [
      { type: 'driver' as const, span: charles },
      { type: 'event' as const, span: span(question, 'Monaco') }
    ];
    const evidence = enumerateSemanticQueries(question, entities);
    if (evidence.type !== 'candidate_set') throw new Error('named-event qualifying evidence was not a candidate set');
    const admission = admitSemanticQueryCandidates({ version: 2, candidates: evidence.candidates }, question, evidence);
    if (admission.type !== 'admitted') throw new Error('named-event qualifying query was not admitted');
    const resolution = await collectSemanticResolutionEvidence({
      question,
      admission,
      driver_resolver: {
        inventoryMentions: async () => [{
          ...charles, candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc']
        }]
      },
      event_resolver: {
        resolve: async () => ({ type: 'resolved', season: 2025, round: 8 }),
        resolveRound: async () => ({ type: 'missing' })
      }
    });
    const plan = planSemanticAnswerFromResolution({ question, admission, resolution });
    const proof = proveSemanticAnswerPlan({ question, entity_inventory: entities, evidence, admission, resolution, plan });
    const authorization = authorizeSemanticPlanCapability({
      proof,
      profile_id: 'semantic-single-source-v1',
      principal_class: 'internal_canary',
      request_id: randomUUID(),
      canary: canary(),
      release_attestation: release({ deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      now_ms: NOW
    });
    expect(authorization.interaction).toMatchObject({
      source_ids: ['qualifying_classification'], event_count: 1, season_count: 1, entity_count: 1
    });
    expect(resolution.entities).toMatchObject([
      { type: 'driver', selected_id: 'charles-leclerc' },
      { type: 'event', selected_id: 'event:2025:8' }
    ]);
  });

  it('rejects five-driver standings points before a capability proof can be minted', () => {
    const drivers = [
      ['Charles Leclerc', 'charles-leclerc'],
      ['George Russell', 'george-russell'],
      ['Lando Norris', 'lando-norris'],
      ['Max Verstappen', 'max-verstappen'],
      ['Oscar Piastri', 'oscar-piastri']
    ];
    const question = `List driver and championship points for ${drivers.map(([name]) => name).join(', ')} from final 2025 driver standings.`;
    expect(enumerateSemanticQueries(question, drivers.map(([name]) => ({
      type: 'driver' as const,
      span: span(question, name)
    })))).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
  });

  it('rejects five-driver race classification before a capability proof can be minted', () => {
    const drivers = [
      'Charles Leclerc', 'George Russell', 'Lando Norris', 'Max Verstappen', 'Oscar Piastri'
    ];
    const question = `List driver and finishing position for ${drivers.join(', ')} from round 1 of final 2025 race classification.`;
    expect(enumerateSemanticQueries(question, drivers.map(name => ({
      type: 'driver' as const,
      span: span(question, name)
    })))).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
  });

  it('rejects five-driver qualifying classification before a capability proof can be minted', () => {
    const drivers = [
      'Charles Leclerc', 'George Russell', 'Lando Norris', 'Max Verstappen', 'Oscar Piastri'
    ];
    const question = `List driver and qualifying position for ${drivers.join(', ')} from round 1 of final 2025 qualifying classification.`;
    expect(enumerateSemanticQueries(question, drivers.map(name => ({
      type: 'driver' as const,
      span: span(question, name)
    })))).toMatchObject({ type: 'abstention', reason: 'unsupported_scope' });
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
        profileId: 'semantic-single-source-v1' as const,
        question: (year: number) => `Show count of finishing position in round 1 of final ${year} race classification.`
      },
      {
        profileId: 'semantic-single-source-v1' as const,
        question: (year: number) => `Show top 10 drivers by count of qualifying position in final ${year} qualifying classification.`
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
  driverMentions?: PositiveProfileCase['driver_mentions'],
  eventNames: readonly string[] = []
) {
  return (await semanticArtifacts(question, entityNames, driverMentions, eventNames)).proof;
}

async function semanticArtifacts(
  question: string,
  entityNames: readonly string[],
  driverMentions?: PositiveProfileCase['driver_mentions'],
  eventNames: readonly string[] = []
) {
  const entities = [
    ...entityNames.map(name => ({ type: 'driver' as const, span: span(question, name) })),
    ...eventNames.map(name => ({ type: 'event' as const, span: span(question, name) }))
  ];
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
    const eventCandidateCount = /\bround\s+\d{1,2}\b/iu.test(testCase.question) ? 1 : 0;
    expect(resolution.resolver_candidates)
      .toBe(input.candidate_count * testCase.driver_mentions.length + eventCandidateCount);
    for (const [index, mention] of testCase.driver_mentions.entries()) {
      expect(resolution.entities[index].candidate_ids).toEqual([...mention.candidates].sort());
      expect(resolution.entities[index].selected_id).toBe(mention.active_candidates[0]);
    }
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
