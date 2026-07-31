import {
  loadSemanticShadowProductionPublicKey,
  parseSingleSemanticShadowProductionEvidenceFile,
  readSemanticShadowProductionEvidenceFile,
  verifySemanticShadowProductionMetadataEvidence
} from './build-semantic-shadow-production-evidence';
import { computeAnswerDatabaseConnectionIdentity } from '../src/db/answer-database';

export function reportSemanticShadowProductionEvidenceFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
) {
  const databaseIdentity = computeAnswerDatabaseConnectionIdentity(required(env, 'F1QL_ANSWER_DATABASE_URL'));
  const evidence = verifySemanticShadowProductionMetadataEvidence(
    parseSingleSemanticShadowProductionEvidenceFile(readSemanticShadowProductionEvidenceFile(path)),
    {
      key_id: required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_KEY_ID'),
      public_key: loadSemanticShadowProductionPublicKey(
        required(env, 'F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64')
      )
    },
    {
      commit_sha: required(env, 'RAILWAY_GIT_COMMIT_SHA'),
      deployment_id: required(env, 'F1QL_ANSWER_DEPLOYMENT_ID'),
      release_id: required(env, 'F1QL_ANSWER_RELEASE_ID'),
      answer_database_target_sha256: databaseIdentity.target_sha256,
      current_user_sha256: databaseIdentity.current_user_sha256,
      current_database_sha256: databaseIdentity.current_database_sha256
    },
    nowMs
  );
  return Object.freeze({
    version: 1 as const,
    kind: 'f1ql_semantic_shadow_production_metadata_report' as const,
    target: 'production' as const,
    status: 'pass' as const,
    commit_sha: evidence.commit_sha,
    deployment_id: evidence.deployment_id,
    release_id: evidence.release_id,
    observed_at: evidence.observed_at,
    case_id: evidence.case_id,
    hashes: Object.freeze({
      catalog: evidence.semantic_catalog_sha256,
      database_binding: evidence.semantic_catalog_database_binding_sha256,
      catalog_artifact: evidence.semantic_catalog_binding_artifact_sha256,
      principal_audit_artifact: evidence.principal_audit_artifact_sha256,
      shadow_log_artifact: evidence.shadow_log_artifact_sha256,
      resolver_sql_fingerprints: evidence.resolver_sql_fingerprint_set_sha256,
      provider_identity: evidence.provider_identity_sha256,
      active_versions: evidence.active_versions_sha256,
      runtime_context: evidence.runtime_context_sha256,
      retained_observation: evidence.retained_observation_sha256
    }),
    reads: evidence.reads,
    shadow: evidence.shadow
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 100_000) {throw new Error(`missing ${name}`);}
  return value;
}

function main(): void {
  const [path] = process.argv.slice(2);
  if (!path || process.argv.slice(2).length !== 1) {
    throw new Error('semantic shadow production metadata report arguments are invalid');
  }
  process.stdout.write(`${JSON.stringify(reportSemanticShadowProductionEvidenceFile(path))}\n`);
}

if (require.main === module) {
  try {main();}
  catch {
    process.stdout.write('{"status":"refused","error":"semantic_shadow_production_evidence_invalid"}\n');
    process.exitCode = 1;
  }
}
