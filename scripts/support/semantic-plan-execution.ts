import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import {
  ActiveAnswerReleaseContext,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationSigningPayload,
  verifyAnswerReleaseAttestation
} from '../../src/f1ql/answer-release-attestation';
import { authorizeSemanticPlanCapability } from '../../src/f1ql/semantic-capability-authorization';
import { SemanticCapabilityAuthorizationConsumptionContext } from '../../src/f1ql/semantic-capability-authorization';
import { SemanticCapabilityProfileId } from '../../src/f1ql/semantic-capability-registry';
import {
  executeAuthorizedSemanticPlan,
  SemanticPlanExecutionOptions,
  VerifiedSemanticPlanExecutionResult
} from '../../src/f1ql/semantic-plan-execution';
import { VerifiedSemanticPlanProof } from '../../src/f1ql/semantic-plan-proof';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';

export const SEMANTIC_EXECUTION_OFFLINE_NOW = Date.parse('2026-07-30T12:00:00.000Z');
export const SEMANTIC_EXECUTION_OFFLINE_RUNTIME = {
  max_concurrency: 2,
  queue_timeout_ms: 2_000,
  request_timeout_ms: 12_000,
  rate_limit_max: 10,
  rate_limit_window_ms: 900_000,
  statement_timeout_ms: 3_000,
  max_work_units: 200,
  max_rows: 100,
  max_response_bytes: 65_536
};

const keyPair = generateKeyPairSync('ed25519');
const trustedKey = { key_id: 'semantic-execution-test-key', public_key: keyPair.publicKey };
const hash = (digit: string) => digit.repeat(64);

export async function executeSemanticPlanRowsOffline(
  proof: VerifiedSemanticPlanProof,
  profileId: SemanticCapabilityProfileId,
  rows: readonly Record<string, unknown>[],
  options: SemanticPlanExecutionOptions = {}
): Promise<VerifiedSemanticPlanExecutionResult> {
  const input = createSemanticPlanExecutionOfflineInput(proof, profileId);
  const client = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT DISTINCT REPLACE(driver_id')) {
        return { rows: [{ driver_id: 'lando-norris' }] };
      }
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
          sql.startsWith("SELECT set_config('statement_timeout'") || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      return { rows };
    },
    release: () => undefined
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return executeAuthorizedSemanticPlan(pool, input.authorization, proof, input.context, {
    now: () => SEMANTIC_EXECUTION_OFFLINE_NOW + 1,
    ...options
  });
}

export function createSemanticPlanExecutionOfflineInput(
  proof: VerifiedSemanticPlanProof,
  profileId: SemanticCapabilityProfileId,
  runtime: typeof SEMANTIC_EXECUTION_OFFLINE_RUNTIME = SEMANTIC_EXECUTION_OFFLINE_RUNTIME
) {
  const release = semanticExecutionTestRelease(runtime);
  const requestId = randomUUID();
  const subjectId = 'semantic-execution-test-subject';
  const authorization = authorizeSemanticPlanCapability({
    proof,
    profile_id: profileId,
    principal_class: 'internal_canary',
    request_id: requestId,
    canary: { stage: 100, subject_id: subjectId, kill_switch: false },
    release_attestation: release,
    now_ms: SEMANTIC_EXECUTION_OFFLINE_NOW
  });
  const context: Omit<SemanticCapabilityAuthorizationConsumptionContext, 'now_ms'> = {
    request_id: requestId,
    principal_class: 'internal_canary',
    canary_stage: 100,
    canary_subject_id: subjectId,
    audience: release.audience,
    deployment_id: release.deployment_id,
    release_attestation: release,
    is_kill_switch_active: () => false
  };
  return { authorization, context };
}

function semanticExecutionTestRelease(runtime: typeof SEMANTIC_EXECUTION_OFFLINE_RUNTIME) {
  const context: ActiveAnswerReleaseContext = {
    release_id: 'semantic-execution-test-release',
    issued_at: '2026-07-30T11:59:00.000Z',
    expires_at: '2026-07-30T12:09:00.000Z',
    commit_sha: 'e'.repeat(40),
    audience: 'f1muse-answer',
    deployment_id: 'semantic-execution-test-deployment',
    canary_policy_version: 'answer-canary-hmac-v1',
    maximum_canary_stage: 100,
    canary_hmac_key_sha256: hash('7'),
    evidence_hashes: {
      manifest_sha256: hash('8'),
      artifact_sha256: hash('9'),
      report_sha256: hash('a'),
      result_fixture_sha256: hash('b'),
      principal_audit_sha256: hash('c'),
      production_evidence_sha256: hash('d'),
      semantic_catalog_hash: SEMANTIC_CATALOG_HASH,
      semantic_catalog_database_binding_hash: hash('f'),
      semantic_catalog_binding_artifact_sha256: hash('0')
    },
    statuses: { semantic: 'pass', safety: 'pass', linker: 'pass' },
    runtime,
    deployment_template_ids: ['final_standings_leader'],
    answer_routing_mode: 'compositional_profiles',
    deployment_capability_profile_ids: [
      'semantic-aggregate-locality-v1',
      'semantic-safe-dimension-join-v1',
      'semantic-single-source-v1'
    ],
    migrated_template_ids: [],
    deployment_principal_classes: ['internal_canary']
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
  }, trustedKey, context, { now_ms: SEMANTIC_EXECUTION_OFFLINE_NOW, max_validity_ms: 600_000, max_age_ms: 300_000 });
}
