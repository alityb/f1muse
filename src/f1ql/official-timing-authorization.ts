import { createHash } from 'node:crypto';
import {
  OFFICIAL_TIMING_CAPABILITY_PROFILE,
  OFFICIAL_TIMING_CAPABILITY_PROFILE_ID,
  OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION,
  OFFICIAL_TIMING_CATALOG_V2_SHA256,
  OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
  OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION,
  OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
  getOfficialTimingCapabilityProfileHash
} from './official-timing-capability';
import { OfficialTimingPipelineResult } from './official-timing-compiler';
import { OfficialTimingPlan } from './official-timing-plan';
import { OfficialTimingPlanProof, verifyOfficialTimingProof } from './official-timing-proof';
import { OfficialTimingQuestionMatch } from './official-timing-question';
import { OfficialTimingResolution } from './official-timing-resolution';
import { OfficialTimingSemanticEvidence } from './official-timing-semantic-query';

export const OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_VERSION = 'semantic-capability-authorization-v34' as const;
export const OFFICIAL_TIMING_AUTHORIZATION_TTL_MS = 5_000;

export type OfficialTimingPrincipalClass = 'internal' | 'internal_canary' | 'public';

export interface OfficialTimingReleaseBinding {
  readonly release_version: 9;
  readonly release_id: string;
  readonly commit_sha: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly expires_at: string;
  readonly routing_mode: 'compositional_profiles';
  readonly allowed_capability_profile_ids: readonly string[];
  readonly allowed_principal_classes: readonly OfficialTimingPrincipalClass[];
  readonly catalog_hash: string;
  readonly release_attestation_sha256: string;
}

export interface OfficialTimingCapabilityAuthorization {
  readonly version: typeof OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_VERSION;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
  readonly request_id: string;
  readonly principal_class: OfficialTimingPrincipalClass;
  readonly canary_stage: number;
  readonly canary_subject_sha256: string;
  readonly audience: string;
  readonly deployment_id: string;
  readonly profile_id: typeof OFFICIAL_TIMING_CAPABILITY_PROFILE_ID;
  readonly profile_version: typeof OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION;
  readonly profile_hash: string;
  readonly interaction_descriptor_version: typeof OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION;
  readonly interaction_hash: string;
  readonly question_sha256: string;
  readonly catalog_hash: string;
  readonly database_binding_target_sha256: string;
  readonly principal_target_sha256: string;
  readonly semantic_evidence_hash: string;
  readonly candidate_set_hash: string;
  readonly semantic_query_hash: string;
  readonly resolution_evidence_hash: string;
  readonly answer_plan_hash: string;
  readonly planned_f1ql_hash: string;
  readonly planned_core_hash: string;
  readonly compiled_hash: string;
  readonly coverage_query_id: string;
  readonly coverage_query_sha256: string;
  readonly coverage_witness_sha256: string;
  readonly coverage_reader_version: string;
  readonly metric_contract_sha256: string;
  readonly output_schema_sha256: string;
  readonly branch_binding_sha256: string;
  readonly proof_hash: string;
  readonly release_attestation_sha256: string;
  readonly result_collection: {
    readonly version: 'semantic-limit-plus-one-v1';
    readonly returned_row_limit: 1;
    readonly completeness_probe_rows: 0;
    readonly observed_row_limit: 1;
  };
  readonly authorization_hash: string;
}

declare const verifiedOfficialTimingAuthorizationBrand: unique symbol;
export type VerifiedOfficialTimingCapabilityAuthorization = OfficialTimingCapabilityAuthorization & {
  readonly [verifiedOfficialTimingAuthorizationBrand]: true;
};
declare const consumedOfficialTimingAuthorizationBrand: unique symbol;
export type ConsumedOfficialTimingCapabilityAuthorization = OfficialTimingCapabilityAuthorization & {
  readonly [consumedOfficialTimingAuthorizationBrand]: true;
};

export class OfficialTimingAuthorizationError extends Error {
  constructor(readonly reason:
    | 'authorization_binding_mismatch' | 'authorization_expired' | 'authorization_replayed'
    | 'invalid_authorization' | 'kill_switch_active' | 'profile_not_released' | 'release_inactive'
    | 'routing_mode_inactive' | 'catalog_mismatch') {
    super(reason);
    this.name = 'OfficialTimingAuthorizationError';
  }
}

const activeAuthorizations = new WeakSet<object>();
const consumedAuthorizations = new WeakSet<object>();

export function authorizeOfficialTimingCapability(input: {
  readonly question: OfficialTimingQuestionMatch;
  readonly evidence: OfficialTimingSemanticEvidence;
  readonly resolution: OfficialTimingResolution;
  readonly plan: OfficialTimingPlan;
  readonly pipeline: OfficialTimingPipelineResult;
  readonly proof: OfficialTimingPlanProof;
  readonly request_id: string;
  readonly principal_class: OfficialTimingPrincipalClass;
  readonly canary: { readonly stage: number; readonly subject_id: string };
  readonly release: OfficialTimingReleaseBinding;
  readonly now_ms?: number;
}): VerifiedOfficialTimingCapabilityAuthorization {
  let proof: OfficialTimingPlanProof;
  try {
    proof = verifyOfficialTimingProof(input.proof, input);
  } catch {
    throw new OfficialTimingAuthorizationError('invalid_authorization');
  }
  const release = validateReleaseBinding(input.release, input.plan, input.principal_class, input.now_ms ?? Date.now());
  assertRequestContext(input.request_id, input.canary);
  if (!OFFICIAL_TIMING_CAPABILITY_PROFILE.canary_stages.includes(input.canary.stage)) {
    throw new OfficialTimingAuthorizationError('profile_not_released');
  }
  const interaction = buildInteraction(input.plan);
  assertInteractionAllowed(interaction);
  const issuedAt = requireSafeTime(input.now_ms ?? Date.now());
  const unsigned = buildUnsignedAuthorization(input, proof, release, interaction, issuedAt);
  const authorization = deepFreeze({ ...unsigned, authorization_hash: hash(unsigned) });
  activeAuthorizations.add(authorization);
  return authorization as VerifiedOfficialTimingCapabilityAuthorization;
}

function requireCoverageReaderVersion(resolution: OfficialTimingResolution): string {
  if (resolution.type !== 'resolved') {
    throw new OfficialTimingAuthorizationError('invalid_authorization');
  }
  return resolution.coverage_reader_version;
}

function assertRequestContext(
  requestId: string,
  canary: { readonly stage: number; readonly subject_id: string }
): void {
  const valid = typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= 128 &&
    typeof canary.subject_id === 'string' && canary.subject_id.length >= 1 && canary.subject_id.length <= 256 &&
    Number.isInteger(canary.stage) && canary.stage >= 0 && canary.stage <= 100;
  if (!valid) {
    throw new OfficialTimingAuthorizationError('invalid_authorization');
  }
}

function buildInteraction(plan: OfficialTimingPlan) {
  return {
    version: OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION,
    profile_id: OFFICIAL_TIMING_CAPABILITY_PROFILE_ID,
    metric_id: plan.metric_id,
    topology: plan.topology,
    source_ids: ['official_race_lap_timing'],
    entity_count: 2,
    driver_ids: [plan.drivers[0].driver_id, plan.drivers[1].driver_id],
    season_values: [2022],
    event_count: 1,
    requested_rows: 1,
    work: plan.work
  };
}

function buildUnsignedAuthorization(
  input: Parameters<typeof authorizeOfficialTimingCapability>[0],
  proof: OfficialTimingPlanProof,
  release: OfficialTimingReleaseBinding,
  interaction: ReturnType<typeof buildInteraction>,
  issuedAt: number
): Omit<OfficialTimingCapabilityAuthorization, 'authorization_hash'> {
  const plan = input.plan;
  return {
    version: OFFICIAL_TIMING_CAPABILITY_AUTHORIZATION_VERSION,
    issued_at_ms: issuedAt,
    expires_at_ms: Math.min(issuedAt + OFFICIAL_TIMING_AUTHORIZATION_TTL_MS, Date.parse(release.expires_at)),
    request_id: input.request_id,
    principal_class: input.principal_class,
    canary_stage: input.canary.stage,
    canary_subject_sha256: sha256(input.canary.subject_id),
    audience: release.audience,
    deployment_id: release.deployment_id,
    profile_id: OFFICIAL_TIMING_CAPABILITY_PROFILE_ID,
    profile_version: OFFICIAL_TIMING_CAPABILITY_PROFILE_VERSION,
    profile_hash: getOfficialTimingCapabilityProfileHash(),
    interaction_descriptor_version: OFFICIAL_TIMING_INTERACTION_DESCRIPTOR_VERSION,
    interaction_hash: hash(interaction),
    question_sha256: plan.question_sha256,
    catalog_hash: plan.catalog_hash,
    database_binding_target_sha256: OFFICIAL_TIMING_DATABASE_BINDING_V2_TARGET_SHA256,
    principal_target_sha256: OFFICIAL_TIMING_PRINCIPAL_V5_TARGET_SHA256,
    semantic_evidence_hash: plan.semantic_evidence_hash,
    candidate_set_hash: plan.candidate_set_hash,
    semantic_query_hash: plan.semantic_query_hash,
    resolution_evidence_hash: plan.resolution_evidence_hash,
    answer_plan_hash: plan.answer_plan_hash,
    planned_f1ql_hash: plan.planned_f1ql_hash,
    planned_core_hash: input.pipeline.planned_core_hash,
    compiled_hash: input.pipeline.compiled.compiled_sha256,
    coverage_query_id: proof.coverage_query_id,
    coverage_query_sha256: proof.coverage_query_sha256,
    coverage_witness_sha256: proof.coverage_witness_sha256,
    coverage_reader_version: requireCoverageReaderVersion(input.resolution),
    metric_contract_sha256: proof.metric_contract_sha256,
    output_schema_sha256: proof.output_schema_sha256,
    branch_binding_sha256: proof.branch_binding_sha256,
    proof_hash: proof.proof_hash,
    release_attestation_sha256: release.release_attestation_sha256,
    result_collection: {
      version: 'semantic-limit-plus-one-v1',
      returned_row_limit: 1,
      completeness_probe_rows: 0,
      observed_row_limit: 1
    }
  };
}

export function consumeOfficialTimingCapabilityAuthorization(
  input: unknown,
  context: {
    readonly request_id: string;
    readonly principal_class: OfficialTimingPrincipalClass;
    readonly is_kill_switch_active: () => boolean;
    readonly now_ms?: number;
  }
): ConsumedOfficialTimingCapabilityAuthorization {
  if (input && typeof input === 'object' && consumedAuthorizations.has(input)) {
    throw new OfficialTimingAuthorizationError('authorization_replayed');
  }
  if (!input || typeof input !== 'object' || !activeAuthorizations.has(input)) {
    throw new OfficialTimingAuthorizationError('invalid_authorization');
  }
  const authorization = input as OfficialTimingCapabilityAuthorization;
  if (context.is_kill_switch_active()) {
    throw new OfficialTimingAuthorizationError('kill_switch_active');
  }
  const now = requireSafeTime(context.now_ms ?? Date.now());
  if (authorization.request_id !== context.request_id ||
      authorization.principal_class !== context.principal_class) {
    throw new OfficialTimingAuthorizationError('authorization_binding_mismatch');
  }
  if (now >= authorization.expires_at_ms) {
    throw new OfficialTimingAuthorizationError('authorization_expired');
  }
  activeAuthorizations.delete(input);
  consumedAuthorizations.add(input);
  return authorization as ConsumedOfficialTimingCapabilityAuthorization;
}

function validateReleaseBinding(
  release: OfficialTimingReleaseBinding,
  plan: OfficialTimingPlan,
  principalClass: OfficialTimingPrincipalClass,
  nowMs: number
): OfficialTimingReleaseBinding {
  assertReleaseActive(release, nowMs);
  if (!release.allowed_capability_profile_ids.includes(OFFICIAL_TIMING_CAPABILITY_PROFILE_ID) ||
      !release.allowed_principal_classes.includes(principalClass)) {
    throw new OfficialTimingAuthorizationError('profile_not_released');
  }
  if (release.catalog_hash !== plan.catalog_hash || plan.catalog_hash !== OFFICIAL_TIMING_CATALOG_V2_SHA256) {
    throw new OfficialTimingAuthorizationError('catalog_mismatch');
  }
  return release;
}

function assertReleaseActive(release: OfficialTimingReleaseBinding, nowMs: number): void {
  if (!isReleaseShapeValid(release) || !isReleaseTemporallyActive(release, nowMs)) {
    throw new OfficialTimingAuthorizationError('release_inactive');
  }
  if (release.routing_mode !== 'compositional_profiles') {
    throw new OfficialTimingAuthorizationError('routing_mode_inactive');
  }
}

function isReleaseShapeValid(release: OfficialTimingReleaseBinding): boolean {
  return Boolean(release) && typeof release === 'object' && release.release_version === 9 &&
    isNonEmptyString(release.release_id) && isNonEmptyString(release.audience) &&
    isNonEmptyString(release.deployment_id) && isNonEmptyString(release.expires_at) &&
    /^[a-f0-9]{64}$/.test(release.release_attestation_sha256) &&
    /^[a-f0-9]{40}$/.test(release.commit_sha);
}

function isReleaseTemporallyActive(release: OfficialTimingReleaseBinding, nowMs: number): boolean {
  const expires = Date.parse(release.expires_at);
  return Number.isFinite(expires) && expires > requireSafeTime(nowMs);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertInteractionAllowed(interaction: {
  readonly metric_id: string;
  readonly entity_count: number;
  readonly driver_ids: readonly string[];
}): void {
  const allowed = OFFICIAL_TIMING_CAPABILITY_PROFILE.complete_interactions
    .some(candidate => candidate.metric_id === interaction.metric_id);
  if (!allowed || interaction.entity_count !== 2 ||
      interaction.driver_ids[0] === interaction.driver_ids[1]) {
    throw new OfficialTimingAuthorizationError('profile_not_released');
  }
}

function requireSafeTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new OfficialTimingAuthorizationError('invalid_authorization');
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing authorization value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}
