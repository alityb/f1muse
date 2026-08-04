import { createHash } from 'node:crypto';
import {
  AnswerPrincipalClass,
  AnswerReleaseAttestationError,
  AnswerRuntimeCeilings,
  getAnswerReleaseAttestationHash,
  isVerifiedAnswerReleaseAttestation,
  VerifiedAnswerReleaseAttestation,
  verifyVerifiedAnswerReleaseAttestationValidity
} from './answer-release-attestation';
import { PlannedF1QLProgram } from './planned-f1ql';
import {
  compilePlannedF1QLResultCollection,
  SEMANTIC_RESULT_COLLECTION_VERSION
} from './planned-compiler';
import { SEMANTIC_CATALOG } from './semantic-catalog';
import { AnswerCanaryStage, selectAnswerCanarySubjectCohort } from './answer-canary';
import {
  getSemanticCapabilityProfile,
  getSemanticCapabilityProfileHash,
  SEMANTIC_CAPABILITY_PROFILE_VERSION,
  SEMANTIC_CAPABILITY_REGISTRY_HASH,
  SemanticCapabilityProfile,
  SemanticCapabilityProfileId
} from './semantic-capability-registry';
import {
  getSemanticPlanProofAuthorizationBindings,
  SEMANTIC_PLAN_PROOF_VERSION,
  VerifiedSemanticPlanProof,
  verifySemanticPlanProof
} from './semantic-plan-proof';

export const SEMANTIC_CAPABILITY_AUTHORIZATION_VERSION = 'semantic-capability-authorization-v6' as const;
export const SEMANTIC_CAPABILITY_AUTHORIZATION_TTL_MS = 5_000;

interface SemanticPlanInteraction {
  readonly topology: 'row_dimension_join' | 'scalar_aggregate_compose' | 'single_source_aggregate' | 'single_source_rows';
  readonly source_ids: readonly string[];
  readonly relationship_ids: readonly string[];
  readonly operator_signature: string;
  readonly operators: readonly string[];
  readonly filter_operators: readonly string[];
  readonly aggregate_functions: readonly string[];
  readonly output_kinds: readonly string[];
  readonly predicate_bindings: readonly string[];
  readonly aggregate_bindings: readonly string[];
  readonly group_bindings: readonly string[];
  readonly output_bindings: readonly string[];
  readonly sort_bindings: readonly string[];
  readonly dimension_ids: readonly string[];
  readonly measure_ids: readonly string[];
  readonly entity_count: number;
  readonly entity_values: readonly string[];
  readonly event_count: number;
  readonly season_count: number;
  readonly season_values: readonly number[];
  readonly output_count: number;
  readonly group_count: number;
  readonly sources: number;
  readonly joins: number;
  readonly depth: number;
  readonly rows: number;
  readonly work_units: number;
}

export interface SemanticResultCollectionAuthorization {
  readonly version: typeof SEMANTIC_RESULT_COLLECTION_VERSION;
  readonly returned_row_limit: number;
  readonly completeness_probe_rows: 0 | 1;
  readonly observed_row_limit: number;
  readonly compiled_hash: string;
}

export interface SemanticCapabilityAuthorization {
  readonly version: typeof SEMANTIC_CAPABILITY_AUTHORIZATION_VERSION;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
  readonly request_id: string;
  readonly principal_class: AnswerPrincipalClass;
  readonly canary_stage: number;
  readonly canary_subject_sha256: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly profile_id: SemanticCapabilityProfileId;
  readonly profile_version: typeof SEMANTIC_CAPABILITY_PROFILE_VERSION;
  readonly profile_hash: string;
  readonly registry_hash: string;
  readonly capability_hash: string;
  readonly interaction_hash: string;
  readonly interaction: SemanticPlanInteraction;
  readonly catalog_hash: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly resolution_evidence_hash: string;
  readonly answer_plan_hash: string;
  readonly planned_f1ql_hash: string;
  readonly core_hash: string;
  readonly topology_hash: string;
  readonly semantic_plan_proof_hash: string;
  readonly semantic_plan_proof_version: typeof SEMANTIC_PLAN_PROOF_VERSION;
  readonly release_attestation_hash: string;
  readonly runtime_ceilings: AnswerRuntimeCeilings;
  readonly result_collection: SemanticResultCollectionAuthorization;
  readonly authorization_hash: string;
}

export interface SemanticCapabilityAuthorizationConsumptionContext {
  readonly request_id: string;
  readonly principal_class: AnswerPrincipalClass;
  readonly canary_stage: number;
  readonly canary_subject_id: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly release_attestation: VerifiedAnswerReleaseAttestation;
  readonly is_kill_switch_active: () => boolean;
  readonly now_ms?: number;
}

declare const verifiedSemanticCapabilityAuthorizationBrand: unique symbol;
export type VerifiedSemanticCapabilityAuthorization = SemanticCapabilityAuthorization & {
  readonly [verifiedSemanticCapabilityAuthorizationBrand]: true;
};

export class SemanticCapabilityAuthorizationError extends Error {
  constructor(readonly reason: 'authorization_binding_mismatch' | 'authorization_expired' | 'authorization_replayed' | 'invalid_authorization' | 'kill_switch_active' | 'profile_not_released' | 'profile_rejected' | 'release_inactive' | 'routing_mode_inactive') {
    super(reason);
    this.name = 'SemanticCapabilityAuthorizationError';
  }
}

const activeAuthorizations = new WeakSet<object>();
const consumedAuthorizations = new WeakSet<object>();

export function authorizeSemanticPlanCapability(input: {
  readonly proof: VerifiedSemanticPlanProof;
  readonly profile_id: SemanticCapabilityProfileId;
  readonly principal_class: AnswerPrincipalClass;
  readonly request_id: string;
  readonly canary: {
    readonly stage: AnswerCanaryStage;
    readonly subject_id: string;
    readonly hmac_key_base64?: string;
    readonly kill_switch: boolean;
  };
  readonly release_attestation: VerifiedAnswerReleaseAttestation;
  readonly now_ms?: number;
}): VerifiedSemanticCapabilityAuthorization {
  if (!isRequestId(input.request_id) || typeof input.canary?.subject_id !== 'string' ||
      input.canary.subject_id.length < 1 || input.canary.subject_id.length > 256) {
    throw new SemanticCapabilityAuthorizationError('invalid_authorization');
  }
  let proof: VerifiedSemanticPlanProof;
  let release: VerifiedAnswerReleaseAttestation;
  try {
    proof = verifySemanticPlanProof(input.proof);
    if (!isVerifiedAnswerReleaseAttestation(input.release_attestation)) {throw new Error('unverified release');}
    release = verifyVerifiedAnswerReleaseAttestationValidity(input.release_attestation, input.now_ms ?? Date.now());
  } catch (error) {
    const reason = error instanceof AnswerReleaseAttestationError ? 'release_inactive' : 'invalid_authorization';
    throw new SemanticCapabilityAuthorizationError(reason);
  }
  if (release.answer_routing_mode !== 'compositional_profiles') {
    throw new SemanticCapabilityAuthorizationError('routing_mode_inactive');
  }
  const profile = getSemanticCapabilityProfile(input.profile_id);
  if (!profile || !release.allowed_capability_profile_ids.includes(input.profile_id) ||
      !release.allowed_principal_classes.includes(input.principal_class) || release.semantic_catalog_hash !== proof.catalog_hash) {
    throw new SemanticCapabilityAuthorizationError('profile_not_released');
  }
  let canary;
  try {
    canary = selectAnswerCanarySubjectCohort({
      kill_switch: input.canary.kill_switch,
      stage: input.canary.stage,
      attestation: release,
      subject_id: input.canary.subject_id,
      hmac_key_base64: input.canary.hmac_key_base64,
      now_ms: input.now_ms
    });
  } catch {
    throw new SemanticCapabilityAuthorizationError('invalid_authorization');
  }
  if (canary.reason === 'kill_switch') {
    throw new SemanticCapabilityAuthorizationError('kill_switch_active');
  }
  if (canary.cohort !== 'canary' || canary.stage === null) {
    throw new SemanticCapabilityAuthorizationError('profile_rejected');
  }
  const proofBindings = getSemanticPlanProofAuthorizationBindings(proof);
  const parent = proofBindings.parent;
  const interaction = describeInteraction(parent.program, parent.cost);
  if (!profileAllows(
    profile, proof, interaction, proofBindings.linked_entities.map(entity => entity.selected_id),
    input.principal_class, canary.stage, release.runtime_ceilings
  )) {
    throw new SemanticCapabilityAuthorizationError('profile_rejected');
  }
  const issuedAt = requireSafeTime(input.now_ms ?? Date.now());
  const releaseExpiry = Date.parse(release.expires_at);
  const profileHash = getSemanticCapabilityProfileHash(profile);
  const interactionHash = sha256(stableSerialize(interaction));
  const collectionCompilation = compilePlannedF1QLResultCollection(
    parent.core_program,
    profile.result_collection.completeness_probe_rows
  );
  const resultCollection = {
    version: SEMANTIC_RESULT_COLLECTION_VERSION,
    returned_row_limit: interaction.rows,
    completeness_probe_rows: profile.result_collection.completeness_probe_rows,
    observed_row_limit: interaction.rows + profile.result_collection.completeness_probe_rows,
    compiled_hash: sha256(stableSerialize(collectionCompilation))
  };
  const draft = {
    version: SEMANTIC_CAPABILITY_AUTHORIZATION_VERSION,
    issued_at_ms: issuedAt,
    expires_at_ms: Math.min(issuedAt + SEMANTIC_CAPABILITY_AUTHORIZATION_TTL_MS, releaseExpiry),
    request_id: input.request_id,
    principal_class: input.principal_class,
    canary_stage: canary.stage,
    canary_subject_sha256: sha256(input.canary.subject_id),
    audience: release.audience,
    deployment_id: release.deployment_id,
    profile_id: profile.id,
    profile_version: profile.version,
    profile_hash: profileHash,
    registry_hash: SEMANTIC_CAPABILITY_REGISTRY_HASH,
    capability_hash: sha256(stableSerialize({ profile_hash: profileHash, interaction_hash: interactionHash })),
    interaction_hash: interactionHash,
    interaction,
    catalog_hash: proof.catalog_hash,
    semantic_evidence_hash: proof.semantic_evidence_hash,
    candidate_set_hash: proof.candidate_set_hash,
    resolution_evidence_hash: proof.resolution_evidence_hash,
    answer_plan_hash: proof.answer_plan_hash,
    planned_f1ql_hash: proof.planned_f1ql_hash,
    core_hash: proof.core_hash,
    topology_hash: proof.topology_hash,
    semantic_plan_proof_hash: proof.proof_hash,
    semantic_plan_proof_version: proof.version,
    release_attestation_hash: getAnswerReleaseAttestationHash(release),
    runtime_ceilings: release.runtime_ceilings,
    result_collection: resultCollection
  };
  const authorization = deepFreeze({
    ...draft,
    authorization_hash: sha256(stableSerialize(draft))
  }) as VerifiedSemanticCapabilityAuthorization;
  activeAuthorizations.add(authorization);
  return authorization;
}

export function verifySemanticCapabilityAuthorization(input: unknown): VerifiedSemanticCapabilityAuthorization {
  if (!input || typeof input !== 'object' || !activeAuthorizations.has(input) || !isDeepFrozen(input)) {
    throw new SemanticCapabilityAuthorizationError('invalid_authorization');
  }
  const authorization = input as VerifiedSemanticCapabilityAuthorization;
  const { authorization_hash: authorizationHash, ...draft } = authorization;
  const profile = getSemanticCapabilityProfile(authorization.profile_id);
  if (authorization.version !== SEMANTIC_CAPABILITY_AUTHORIZATION_VERSION ||
      authorization.registry_hash !== SEMANTIC_CAPABILITY_REGISTRY_HASH ||
      !profile || !matchesCurrentResultCollection(authorization, profile) ||
      authorizationHash !== sha256(stableSerialize(draft))) {
    throw new SemanticCapabilityAuthorizationError('invalid_authorization');
  }
  return authorization;
}

function matchesCurrentResultCollection(
  authorization: SemanticCapabilityAuthorization,
  profile: SemanticCapabilityProfile
): boolean {
  return [
    authorization.profile_version === profile.version,
    authorization.profile_hash === getSemanticCapabilityProfileHash(profile),
    authorization.result_collection.version === SEMANTIC_RESULT_COLLECTION_VERSION,
    authorization.result_collection.returned_row_limit === authorization.interaction.rows,
    authorization.result_collection.completeness_probe_rows === profile.result_collection.completeness_probe_rows,
    authorization.result_collection.observed_row_limit ===
      authorization.interaction.rows + profile.result_collection.completeness_probe_rows,
    authorization.result_collection.returned_row_limit <= authorization.runtime_ceilings.max_rows
  ].every(Boolean);
}

export function consumeSemanticCapabilityAuthorization(
  input: unknown,
  context: SemanticCapabilityAuthorizationConsumptionContext
): VerifiedSemanticCapabilityAuthorization {
  const authorization = validateSemanticCapabilityAuthorization(input, context, false);
  consumedAuthorizations.add(authorization);
  return authorization;
}

export function assertSemanticCapabilityAuthorizationActive(
  input: unknown,
  context: SemanticCapabilityAuthorizationConsumptionContext
): VerifiedSemanticCapabilityAuthorization {
  return validateSemanticCapabilityAuthorization(input, context, true);
}

function validateSemanticCapabilityAuthorization(
  input: unknown,
  context: SemanticCapabilityAuthorizationConsumptionContext,
  requireConsumed: boolean
): VerifiedSemanticCapabilityAuthorization {
  const authorization = verifySemanticCapabilityAuthorization(input);
  if (!requireConsumed && consumedAuthorizations.has(authorization)) {
    throw new SemanticCapabilityAuthorizationError('authorization_replayed');
  }
  if (requireConsumed && !consumedAuthorizations.has(authorization)) {
    throw new SemanticCapabilityAuthorizationError('invalid_authorization');
  }
  try {
    if (typeof context?.is_kill_switch_active !== 'function' || context.is_kill_switch_active()) {
      throw new SemanticCapabilityAuthorizationError('kill_switch_active');
    }
  } catch (error) {
    if (error instanceof SemanticCapabilityAuthorizationError) {
      throw error;
    }
    throw new SemanticCapabilityAuthorizationError('kill_switch_active');
  }
  const now = requireSafeTime(context.now_ms ?? Date.now());
  let release: VerifiedAnswerReleaseAttestation;
  try {
    release = verifyVerifiedAnswerReleaseAttestationValidity(context.release_attestation, now);
  } catch {
    throw new SemanticCapabilityAuthorizationError('release_inactive');
  }
  if (now < authorization.issued_at_ms || now >= authorization.expires_at_ms) {
    throw new SemanticCapabilityAuthorizationError('authorization_expired');
  }
  if (authorization.request_id !== context.request_id || authorization.principal_class !== context.principal_class ||
      authorization.canary_stage !== context.canary_stage || authorization.audience !== context.audience ||
      authorization.canary_subject_sha256 !== sha256(context.canary_subject_id) ||
      authorization.deployment_id !== context.deployment_id ||
      authorization.release_attestation_hash !== getAnswerReleaseAttestationHash(release)) {
    throw new SemanticCapabilityAuthorizationError('authorization_binding_mismatch');
  }
  return authorization;
}

function profileAllows(
  rawProfile: SemanticCapabilityProfile,
  proof: VerifiedSemanticPlanProof,
  interaction: SemanticPlanInteraction,
  resolvedEntityValues: readonly string[],
  principal: AnswerPrincipalClass,
  canaryStage: number,
  runtime: AnswerRuntimeCeilings
): boolean {
  const profile = rawProfile as unknown as ProfileShape;
  const limits = profile.limits;
  return proof.catalog_hash === profile.catalog_hash && profile.principal_classes.includes(principal) &&
    profile.canary_stages.includes(canaryStage) &&
    profile.topology.includes(interaction.topology) && profile.source_sets.some(set => sameStrings(set, interaction.source_ids)) &&
    sameStrings(profile.relationship_ids, interaction.relationship_ids) &&
    profile.operator_signatures.includes(interaction.operator_signature) &&
    interaction.operators.every(operator => profile.operators.includes(operator)) &&
    interaction.filter_operators.every(operator => profile.filter_operators.includes(operator)) &&
    interaction.aggregate_functions.every(operation => profile.aggregate_functions.includes(operation)) &&
    interaction.output_kinds.every(kind => profile.output_kinds.includes(kind)) &&
    interaction.sort_bindings.every(binding => {
      const [, direction, nulls] = binding.split(':');
      return profile.sort_directions.includes(direction) && profile.null_orders.includes(nulls);
    }) &&
    interaction.dimension_ids.every(id => profile.dimension_ids.includes(id)) &&
    interaction.measure_ids.every(id => profile.measure_ids.includes(id)) &&
    profile.complete_interactions.some(reviewed => reviewedInteractionAllows(
      reviewed, proof, interaction, resolvedEntityValues
    )) &&
    interaction.sources <= limits.sources && interaction.joins <= limits.joins && interaction.depth <= limits.depth &&
    interaction.output_count <= limits.outputs && interaction.group_count <= limits.groups &&
    interaction.entity_count <= limits.entities && interaction.event_count <= limits.events && interaction.season_count <= limits.seasons &&
    interaction.rows <= limits.rows && interaction.work_units <= limits.work_units &&
    interaction.rows <= runtime.max_rows && interaction.work_units <= runtime.max_work_units &&
    profile.result_collection.version === SEMANTIC_RESULT_COLLECTION_VERSION &&
    profile.result_collection.completeness_probe_rows === (interaction.topology === 'scalar_aggregate_compose' ? 0 : 1) &&
    profile.scope === 'historical_final' && historicalCoverageAllows(interaction.source_ids, interaction.season_values);
}

interface ProfileShape {
  readonly catalog_hash: string;
  readonly topology: readonly string[];
  readonly source_sets: readonly (readonly string[])[];
  readonly relationship_ids: readonly string[];
  readonly operator_signatures: readonly string[];
  readonly operators: readonly string[];
  readonly filter_operators: readonly string[];
  readonly aggregate_functions: readonly string[];
  readonly output_kinds: readonly string[];
  readonly sort_directions: readonly string[];
  readonly null_orders: readonly string[];
  readonly dimension_ids: readonly string[];
  readonly measure_ids: readonly string[];
  readonly principal_classes: readonly string[];
  readonly canary_stages: readonly number[];
  readonly complete_interactions: readonly {
    readonly entity_count?: { readonly min: number; readonly max: number };
    readonly question_sha256?: string;
    readonly season_values?: readonly number[];
    readonly entity_values?: readonly string[];
    readonly predicate_bindings: readonly string[];
    readonly aggregate_bindings: readonly string[];
    readonly group_bindings: readonly string[];
    readonly output_bindings: readonly string[];
    readonly sort_bindings: readonly string[];
    readonly requested_rows: number;
  }[];
  readonly scope: string;
  readonly result_collection: {
    readonly version: typeof SEMANTIC_RESULT_COLLECTION_VERSION;
    readonly completeness_probe_rows: 0 | 1;
  };
  readonly limits: Readonly<Record<'sources' | 'joins' | 'depth' | 'outputs' | 'groups' | 'entities' | 'events' | 'seasons' | 'rows' | 'work_units', number>>;
}

function describeInteraction(program: PlannedF1QLProgram, cost: {
  readonly units: number;
  readonly sources: number;
  readonly joins: number;
  readonly depth: number;
  readonly requested_rows: number;
}): SemanticPlanInteraction {
  const project = program.root.input.input;
  const rootInput = project.input;
  const sourceIds = sortedUnique(collectValues(rootInput, 'source_id'));
  const relationshipIds = sortedUnique(collectValues(rootInput, 'relationship_id'));
  const operators = sortedUnique(collectValues(program.root, 'op'));
  const filterOperators = sortedUnique(collectValues(rootInput, 'operator'));
  const concepts = collectConcepts(program.root);
  const entityIds = sortedUnique(collectPredicateValues(rootInput, 'driver_id')
    .filter((value): value is string => typeof value === 'string'));
  const seasons = sortedUniqueNumbers(collectPredicateValues(rootInput, 'season').filter((value): value is number => typeof value === 'number'));
  const rounds = sortedUniqueNumbers(collectPredicateValues(rootInput, 'round').filter((value): value is number => typeof value === 'number'));
  const groupCount = collectArrays(rootInput, 'group_by').reduce((total, group) => total + group.length, 0);
  const outputBindings = project.outputs.map(outputBinding);
  const sortBindings = program.root.input.keys.map(key => `${key.output_id}:${key.direction}:${key.nulls}`);
  return deepFreeze({
    topology: topologyOf(rootInput),
    source_ids: sourceIds,
    relationship_ids: relationshipIds,
    operator_signature: operatorSignature(program.root),
    operators,
    filter_operators: filterOperators,
    aggregate_functions: sortedUnique(collectValues(rootInput, 'function')),
    output_kinds: sortedUnique(collectValues(project.outputs, 'kind')),
    predicate_bindings: collectPredicateBindings(rootInput),
    aggregate_bindings: collectAggregateBindings(rootInput),
    group_bindings: collectGroupBindings(rootInput),
    output_bindings: outputBindings,
    sort_bindings: sortBindings,
    dimension_ids: concepts.dimensions,
    measure_ids: concepts.measures,
    entity_count: entityIds.length,
    entity_values: entityIds,
    event_count: rounds.length,
    season_count: seasons.length,
    season_values: seasons,
    output_count: project.outputs.length,
    group_count: groupCount,
    sources: cost.sources,
    joins: cost.joins,
    depth: cost.depth,
    rows: cost.requested_rows,
    work_units: cost.units
  });
}

function completeInteraction(interaction: SemanticPlanInteraction) {
  return {
    predicate_bindings: interaction.predicate_bindings,
    aggregate_bindings: interaction.aggregate_bindings,
    group_bindings: interaction.group_bindings,
    output_bindings: interaction.output_bindings,
    sort_bindings: interaction.sort_bindings,
    requested_rows: interaction.rows
  };
}

function reviewedInteractionAllows(
  reviewed: ProfileShape['complete_interactions'][number],
  proof: VerifiedSemanticPlanProof,
  interaction: SemanticPlanInteraction,
  resolvedEntityValues: readonly string[]
): boolean {
  const {
    entity_count: entityCount,
    question_sha256: questionSha256,
    season_values: seasonValues,
    entity_values: entityValues,
    ...structure
  } = reviewed;
  return stableSerialize(structure) === stableSerialize(completeInteraction(interaction)) &&
    (entityCount === undefined ||
      (interaction.entity_count >= entityCount.min && interaction.entity_count <= entityCount.max)) &&
    (questionSha256 === undefined || questionSha256 === proof.question_sha256) &&
    (seasonValues === undefined || stableSerialize(seasonValues) === stableSerialize(interaction.season_values)) &&
    (entityValues === undefined || stableSerialize(entityValues) === stableSerialize(resolvedEntityValues));
}

function topologyOf(input: PlannedF1QLProgram['root']['input']['input']['input']): SemanticPlanInteraction['topology'] {
  if (input.op === 'join') {return 'row_dimension_join';}
  if (input.op === 'compose') {return 'scalar_aggregate_compose';}
  if (input.op === 'aggregate') {return 'single_source_aggregate';}
  return 'single_source_rows';
}

function operatorSignature(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { op?: unknown }).op !== 'string') {return '';}
  const record = value as Record<string, unknown> & { op: string };
  let children: unknown[] = [];
  if (record.op === 'join') {
    children = [record.left, record.right];
  } else if (record.op === 'compose') {
    children = record.inputs as unknown[];
  } else if (record.input) {
    children = [record.input];
  }
  return children.length === 0 ? record.op : `${record.op}(${children.map(operatorSignature).join(',')})`;
}

function collectConcepts(value: unknown): { dimensions: string[]; measures: string[] } {
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  walk(value, record => {
    if (typeof record.source_id !== 'string' || typeof record.concept_id !== 'string') {return;}
    const id = `${record.source_id}.${record.concept_id}`;
    const source = SEMANTIC_CATALOG.sources.find(candidate => candidate.id === record.source_id);
    if (source?.measures.some(measure => measure.id === record.concept_id)) {measures.add(id);}
    else if (source?.dimensions.some(dimension => dimension.id === record.concept_id)) {dimensions.add(id);}
  });
  return { dimensions: [...dimensions].sort(compareText), measures: [...measures].sort(compareText) };
}

function collectPredicateBindings(value: unknown): string[] {
  const bindings: string[] = [];
  walk(value, record => {
    const concept = record.concept as { source_id?: unknown; concept_id?: unknown } | undefined;
    if (typeof record.operator === 'string' && typeof concept?.source_id === 'string' && typeof concept.concept_id === 'string') {
      bindings.push(`${concept.source_id}.${concept.concept_id}:${record.operator}`);
    }
  });
  return bindings.sort(compareText);
}

function collectAggregateBindings(value: unknown): string[] {
  const bindings: string[] = [];
  walk(value, record => {
    const concept = record.concept as { source_id?: unknown; concept_id?: unknown } | undefined;
    if (typeof record.function === 'string' && typeof record.as === 'string' &&
        typeof concept?.source_id === 'string' && typeof concept.concept_id === 'string') {
      bindings.push(`${concept.source_id}.${concept.concept_id}:${record.function}->${record.as}`);
    }
  });
  return bindings;
}

function collectGroupBindings(value: unknown): string[] {
  return collectArrays(value, 'group_by').flatMap(group => group.map(item => {
    const concept = item as { source_id?: unknown; concept_id?: unknown };
    return `${String(concept.source_id)}.${String(concept.concept_id)}`;
  }));
}

function outputBinding(output: PlannedF1QLProgram['root']['input']['input']['outputs'][number]): string {
  if (output.kind === 'concept') {
    return `concept:${output.concept.source_id}.${output.concept.concept_id}->${output.as}`;
  }
  if (output.kind === 'aggregate') {
    return `aggregate:${output.measure_as}->${output.as}`;
  }
  return `composed_aggregate:${output.source_id}.${output.measure_as}->${output.as}`;
}

function collectPredicateValues(value: unknown, conceptId: string): unknown[] {
  const values: unknown[] = [];
  walk(value, record => {
    const concept = record.concept;
    if (!concept || typeof concept !== 'object' || (concept as { concept_id?: unknown }).concept_id !== conceptId) {return;}
    if ('value' in record) {values.push(record.value);}
    if (Array.isArray(record.values)) {values.push(...record.values);}
  });
  return values;
}

function collectValues(value: unknown, key: string): string[] {
  const values: string[] = [];
  walk(value, record => {if (typeof record[key] === 'string') {values.push(record[key] as string);}});
  return values;
}

function collectArrays(value: unknown, key: string): unknown[][] {
  const values: unknown[][] = [];
  walk(value, record => {if (Array.isArray(record[key])) {values.push(record[key] as unknown[]);}});
  return values;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') {return;}
  if (Array.isArray(value)) {
    for (const child of value) {walk(child, visit);}
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) {walk(child, visit);}
}

function requireSafeTime(value: number): number {
  if (!Number.isSafeInteger(value)) {throw new SemanticCapabilityAuthorizationError('invalid_authorization');}
  return value;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function historicalCoverageAllows(sourceIds: readonly string[], seasons: readonly number[]): boolean {
  if (seasons.length === 0) {return false;}
  return sourceIds.every(sourceId => {
    const source = SEMANTIC_CATALOG.sources.find(candidate => candidate.id === sourceId);
    const through = source?.scope.final_season_through;
    return through !== null && through !== undefined && seasons.every(season => season >= 1950 && season <= through);
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sortedUniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && Object.isFrozen(value) &&
    Object.values(value).every(child => !child || typeof child !== 'object' || isDeepFrozen(child)));
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
