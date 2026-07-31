import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import express from 'express';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createProgramSemanticShadowRoutes } from '../../src/api/routes/program-semantic-shadow';
import {
  buildSemanticShadowProductionEvidenceFile,
  buildSemanticShadowProductionMetadataEvidence,
  computeSemanticShadowResolverFingerprintSetSha256,
  verifySemanticShadowProductionMetadataEvidence
} from '../../scripts/build-semantic-shadow-production-evidence';
import { reportSemanticShadowProductionEvidenceFile } from '../../scripts/report-semantic-shadow-production-evidence';
import {
  getSemanticCatalogBindingArtifactSigningPayload,
  UnsignedSemanticCatalogBindingArtifact
} from '../../scripts/audit-semantic-catalog-binding';
import {
  ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS,
  ANSWER_PRINCIPAL_AUDIT_VERSION,
  ANSWER_PRINCIPAL_REQUIRED_RELATIONS,
  getAnswerPrincipalAuditSigningPayload,
  UnsignedAnswerPrincipalAuditReport
} from '../../scripts/audit-answer-principal';
import {
  computeSemanticCatalogDatabaseBindingHash,
  SemanticCatalogDatabaseBindingMaterial,
  SEMANTIC_CATALOG,
  SEMANTIC_CATALOG_HASH
} from '../../src/f1ql/semantic-catalog';
import { sanitizeSemanticShadowRetainedObservation } from '../../src/f1ql/semantic-shadow-retained-observation';
import { attachSemanticShadowProductionCapture } from '../../src/f1ql/semantic-shadow-production-capture';
import { computeAnswerDatabaseConnectionIdentity } from '../../src/db/answer-database';
import {
  SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256,
  SEMANTIC_SHADOW_RESOLVER_STATEMENTS
} from '../../src/f1ql/semantic-shadow-resolver-reader';
import { SemanticShadowProposalRequest } from '../../src/f1ql/semantic-shadow-planner';
import { enumerateSemanticQueries } from '../../src/f1ql/semantic-query';
import { semanticShadowActiveVersions } from '../../src/f1ql/semantic-shadow-planner';
import { getConfiguredSemanticCandidateModelIdentity } from '../../src/f1ql/semantic-candidate-translator';
import reviewedSnapshot from '../fixtures/compositional-regression.snapshot.json';
import { reviewedSemanticShadowReportRequirements } from '../../scripts/report-semantic-shadow';

const COMMIT_SHA = 'a'.repeat(40);
const DEPLOYMENT_ID = 'semantic-shadow-production-test-deployment';
const RELEASE_ID = 'semantic-shadow-production-test-release';
const KEY_ID = 'semantic-shadow-production-test-key';
const CATALOG_TIME = '2026-07-30T12:00:00.000Z';
const PRINCIPAL_TIME = '2026-07-30T11:59:00.000Z';
const SHADOW_TIME = '2026-07-30T12:01:00.000Z';
const NOW_MS = Date.parse('2026-07-30T12:02:00.000Z');
const CAPTURE_NONCE = 'n'.repeat(43);
const DATABASE_URL = 'postgresql://f1ql_answer:unused@db.example.test:5432/f1muse';
const DATABASE_IDENTITY = computeAnswerDatabaseConnectionIdentity(DATABASE_URL);
const DATABASE_TARGET_SHA256 = DATABASE_IDENTITY.target_sha256;
const CAPTURE_KEY_ID = 'semantic-shadow-production-capture-test-key';
const captureKeys = generateKeyPairSync('ed25519');
const INTERNAL_TOKEN = 'semantic-shadow-production-internal-token';
const PRODUCTION_QUESTION = 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.';
const catalogKeys = generateKeyPairSync('ed25519');
const evidenceKeys = generateKeyPairSync('ed25519');
const PROVIDER = Object.freeze({
  provider: 'openai-compatible' as const,
  endpoint_sha256: '1'.repeat(64),
  model_sha256: '2'.repeat(64),
  catalog_projection_sha256: '3'.repeat(64),
  prompt_sha256: '4'.repeat(64),
  schema_sha256: '5'.repeat(64),
  request_config_sha256: '6'.repeat(64)
});

describe('WP8 production metadata evidence', () => {
  it('binds one real route-emitted stage-zero event to signed catalog fingerprints with separate read counts', async () => {
    const catalog = catalogArtifact();
    const catalogBytes = Buffer.from(`${JSON.stringify(catalog)}\n`, 'utf8');
    const retainedLine = await captureRetainedRouteLine();
    const evidence = buildSemanticShadowProductionMetadataEvidence(
      Buffer.from(`${JSON.stringify(principalAudit())}\n`, 'utf8'),
      catalogBytes,
      Buffer.from(`${JSON.stringify({ message: retainedLine, timestamp: SHADOW_TIME })}\n`, 'utf8'),
      context(),
      NOW_MS
    );

    expect(evidence).toMatchObject({
      status: 'passed',
      case_id: 'promoted-safe-dimension-join',
      semantic_catalog_sha256: SEMANTIC_CATALOG_HASH,
      resolver_sql_fingerprint_set_sha256: computeSemanticShadowResolverFingerprintSetSha256(),
      shadow: {
        terminal: 'semantic', rollout_stage: 0, outcome: 'answer', reason: 'plan_proven',
        topology_code: 'row_dimension_join', source_set_code: 'event_classification__event_metadata'
      },
      reads: {
        fingerprint_transactions: 1, fingerprint_statements: 5,
        fingerprint_required_grain_checks: 1, route_fingerprint_reads: 0,
        resolver_transactions: 2, resolver_statements: 2, resolver_returned_rows: 1,
        result_query_calls: 0
      }
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(verifySemanticShadowProductionMetadataEvidence(evidence, {
      key_id: KEY_ID, public_key: evidenceKeys.publicKey
    }, context(), NOW_MS)).toEqual(evidence);

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('List driver');
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('f1ql.answer_event_identity');
  });

  it('rejects cross-context, tampered, stale, repeated, operational, and local-collector evidence', () => {
    const catalog = catalogArtifact();
    const catalogBytes = Buffer.from(`${JSON.stringify(catalog)}\n`, 'utf8');
    const principalBytes = Buffer.from(`${JSON.stringify(principalAudit())}\n`, 'utf8');
    const retained = retainedEvent();
    const build = (log: string, nowMs = NOW_MS) => buildSemanticShadowProductionMetadataEvidence(
      principalBytes, catalogBytes, Buffer.from(log, 'utf8'), context(), nowMs
    );
    const evidence = build(railwayLog(retained));

    expect(() => verifySemanticShadowProductionMetadataEvidence(evidence, {
      key_id: KEY_ID, public_key: evidenceKeys.publicKey
    }, { ...context(), deployment_id: 'wrong-deployment' }, NOW_MS)).toThrow('context');
    expect(() => verifySemanticShadowProductionMetadataEvidence({
      ...evidence,
      reads: { ...evidence.reads, resolver_returned_rows: 2 }
    }, { key_id: KEY_ID, public_key: evidenceKeys.publicKey }, context(), NOW_MS)).toThrow('signature');
    expect(() => build(railwayLog(retained), Date.parse('2026-08-01T12:02:00.000Z'))).toThrow('stale');
    expect(() => build(`${railwayLog(retained)}${railwayLog(retained)}`)).toThrow('exactly one');
    expect(() => build(railwayLog(retainedEvent({
      ...PROVIDER, model_sha256: '9'.repeat(64)
    })))).toThrow('oracle');
    expect(() => build(railwayLog(retainedEvent(PROVIDER, {
      ...semanticShadowActiveVersions(), planner: 'unreviewed-planner-version'
    })))).toThrow('oracle');
    expect(() => build(railwayLog(retained, '2026-07-30T12:10:00.000Z'))).toThrow('Railway envelope');
    expect(() => buildSemanticShadowProductionMetadataEvidence(
      principalBytes,
      catalogBytes,
      Buffer.from(railwayLog(retained), 'utf8'),
      {
        ...context(),
        capture_trusted_key: { key_id: CAPTURE_KEY_ID, public_key: generateKeyPairSync('ed25519').publicKey }
      },
      NOW_MS
    )).toThrow('capture signature');
    expect(() => buildSemanticShadowProductionMetadataEvidence(
      Buffer.from(`${JSON.stringify(principalAudit('9'.repeat(64)))}\n`, 'utf8'),
      catalogBytes,
      Buffer.from(railwayLog(retained), 'utf8'),
      context(),
      NOW_MS
    )).toThrow('database binding');
    expect(() => buildSemanticShadowProductionMetadataEvidence(
      Buffer.from(`${JSON.stringify(principalAudit(undefined, 'e'.repeat(64)))}\n`, 'utf8'),
      catalogBytes,
      Buffer.from(railwayLog(retained), 'utf8'),
      context(),
      NOW_MS
    )).toThrow('database binding');
    expect(() => buildSemanticShadowProductionMetadataEvidence(
      principalBytes,
      catalogBytes,
      Buffer.from(railwayLog(retained), 'utf8'),
      { ...context(), key_id: 'separate-id-same-key', private_key: catalogKeys.privateKey },
      NOW_MS
    )).toThrow('context');
    expect(() => build(railwayLog({
      ...retained,
      terminal: 'operational_failure',
      observation: undefined,
      failure: { reason: 'request_timeout', stage: 'proposal', total_ms: 10 },
      result_query_calls: 0
    }))).toThrow();
    expect(() => build(railwayLog({
      ...retained,
      evidence_binding: {
        corpus_sha256: '1'.repeat(64), run_sha256: '2'.repeat(64), case_index: 1,
        repetition_index: 0, attempt_sha256: '3'.repeat(64)
      }
    }))).toThrow();
  });

  it('writes an exclusive private artifact and independently reports it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-shadow-production-evidence-'));
    try {
      const paths = {
        principal_audit: join(directory, 'principal.json'),
        catalog_artifact: join(directory, 'catalog.json'),
        shadow_log: join(directory, 'shadow.jsonl'),
        output: join(directory, 'evidence.json')
      };
      const environment = buildEnvironment();
      writeFileSync(paths.principal_audit, `${JSON.stringify(principalAudit())}\n`);
      writeFileSync(paths.catalog_artifact, `${JSON.stringify(catalogArtifact())}\n`);
      writeFileSync(paths.shadow_log, railwayLog(retainedEvent(
        getConfiguredSemanticCandidateModelIdentity(environment)
      )));
      expect(() => buildSemanticShadowProductionEvidenceFile(paths, {}, NOW_MS)).toThrow('not enabled');
      expect(buildSemanticShadowProductionEvidenceFile(paths, environment, NOW_MS)).toMatchObject({
        output: paths.output, status: 'pass', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });
      expect(statSync(paths.output).mode & 0o777).toBe(0o600);
      expect(reportSemanticShadowProductionEvidenceFile(paths.output, reportEnvironment(), NOW_MS)).toMatchObject({
        status: 'pass', deployment_id: DEPLOYMENT_ID, case_id: 'promoted-safe-dimension-join',
        reads: { result_query_calls: 0 }
      });
      expect(() => buildSemanticShadowProductionEvidenceFile(paths, environment, NOW_MS)).toThrow();

      const duplicate = readFileSync(paths.catalog_artifact, 'utf8').replace(
        '"version":1', '"version":1,"version":1'
      );
      const duplicatePath = join(directory, 'duplicate.json');
      writeFileSync(duplicatePath, duplicate);
      expect(() => buildSemanticShadowProductionEvidenceFile({
        ...paths, catalog_artifact: duplicatePath, output: join(directory, 'duplicate-output.json')
      }, environment, NOW_MS)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps production evidence modules disconnected from every executor', () => {
    for (const path of [
      'scripts/build-semantic-shadow-production-evidence.ts',
      'scripts/report-semantic-shadow-production-evidence.ts'
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/from ['"].*(?:executor|answer-execution)['"]/u);
      expect(source).not.toContain('executeF1QL');
      expect(source).not.toContain('executeAuthorizedSemanticPlan');
    }
  });
});

async function captureRetainedRouteLine(): Promise<string> {
  const logs: string[] = [];
  const client = {
    async query(sql: string) {
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK' || sql.startsWith("SELECT set_config('statement_timeout'")) {
        return { rows: [] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_unscoped ||
          sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.driver_inventory_scoped) {
        return { rows: [] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_name) {
        return { rows: [{ season: 2025, round: 1, identity: 'Australian Grand Prix' }] };
      }
      if (sql === SEMANTIC_SHADOW_RESOLVER_STATEMENTS.event_round) {
        return { rows: [{ season: 2025, round: 1 }] };
      }
      throw new Error('unexpected route evidence query');
    },
    release() {}
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const environment: NodeJS.ProcessEnv = {
    F1QL_SEMANTIC_SHADOW_ENABLED: 'true',
    F1QL_SEMANTIC_SHADOW_STAGE: '0',
    F1QL_SEMANTIC_SHADOW_INTERNAL_TOKEN: INTERNAL_TOKEN,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_ENABLED: 'true',
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_TARGET: 'production',
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_NONCE: CAPTURE_NONCE,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_KEY_ID: CAPTURE_KEY_ID,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_PRIVATE_KEY_BASE64:
      captureKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    F1QL_ANSWER_DATABASE_URL: DATABASE_URL,
    RAILWAY_GIT_COMMIT_SHA: COMMIT_SHA,
    F1QL_ANSWER_DEPLOYMENT_ID: DEPLOYMENT_ID,
    F1QL_ANSWER_RELEASE_ID: RELEASE_ID
  };
  const app = express();
  app.use(express.json());
  app.use('/', createProgramSemanticShadowRoutes(pool, {
    environment: () => environment,
    proposer: { propose: async request => exactProposal(request) },
    providerIdentity: PROVIDER,
    logger: line => logs.push(line),
    timestamp: () => SHADOW_TIME
  }, () => {throw new Error('semantic shadow executor must not run');}));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolveServer => {
    const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening));
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/program/semantic-shadow`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_TOKEN}`,
          'X-F1QL-Semantic-Shadow-Evidence-Nonce': CAPTURE_NONCE
        },
        body: JSON.stringify({ question: PRODUCTION_QUESTION })
      }
    );
    const responseBody = await response.json();
    expect(response.status, JSON.stringify({ responseBody, logs })).toBe(200);
    expect(logs).toHaveLength(1);
    return logs[0];
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
}

function exactProposal(request: SemanticShadowProposalRequest): unknown {
  const evidence = enumerateSemanticQueries(request.question, []);
  if (evidence.type !== 'candidate_set') {throw new Error('production evidence question did not enumerate candidates');}
  return { version: request.semantic_query_version, candidates: evidence.candidates };
}

function retainedEvent(
  providerIdentity = PROVIDER,
  versions = semanticShadowActiveVersions()
) {
  const snapshot = reviewedSnapshot as { cases: Array<{ id: string }> };
  const index = snapshot.cases.findIndex(item => item.id === 'promoted-safe-dimension-join');
  const expected = reviewedSemanticShadowReportRequirements(reviewedSnapshot).cases[index];
  const planWork = expected.plan_work!;
  const hashes = expected.hashes!;
  const retained = sanitizeSemanticShadowRetainedObservation({
    version: 'semantic-shadow-retained-v2',
    timestamp: SHADOW_TIME,
    mode: 'semantic_shadow',
    rollout_stage: 0,
    question_sha256: expected.question_sha256,
    provider_identity: providerIdentity,
    production_evidence_binding: {
      commit_sha256: sha256(COMMIT_SHA),
      deployment_id_sha256: sha256(DEPLOYMENT_ID),
      release_id_sha256: sha256(RELEASE_ID),
      capture_nonce_sha256: sha256(CAPTURE_NONCE),
      answer_database_target_sha256: DATABASE_TARGET_SHA256,
      answer_database_user_sha256: DATABASE_IDENTITY.current_user_sha256,
      answer_database_name_sha256: DATABASE_IDENTITY.current_database_sha256,
      resolver_sql_fingerprint_set_sha256: SEMANTIC_SHADOW_RESOLVER_SQL_FINGERPRINT_SET_SHA256
    },
    resolver_transaction_count: 2,
    resolver_transaction_counters: {
      statement_count: 2, returned_row_count: 1,
      statements: {
        driver_inventory_unscoped: 1, driver_inventory_scoped: 0, event_name: 1, event_round: 0
      }
    },
    terminal: 'semantic',
    observation: {
      version: 'semantic-shadow-observation-v1',
      outcome: expected.outcome,
      reason: expected.reason,
      candidate_counts: expected.candidate_counts,
      resolver_counts: {
        inventory_reads: 1, event_reads: 1, fingerprint_reads: 0,
        inventory_entities: 0, verified_candidates: planWork.resolver_candidates
      },
      topology_code: expected.topology_code,
      source_set_code: expected.source_set_code,
      operator_set_code: expected.operator_set_code,
      plan_work: { model: 'semantic-plan-work-v1', ...planWork },
      hashes: { catalog_sha256: SEMANTIC_CATALOG_HASH, ...hashes },
      template_dual: { enabled: true, status: expected.template_dual_status },
      latencies: { total_ms: 10 },
      result_query_calls: 0,
      versions
    }
  });
  return attachSemanticShadowProductionCapture(retained, {
    key_id: CAPTURE_KEY_ID,
    private_key: captureKeys.privateKey
  });
}

function catalogArtifact() {
  const material: SemanticCatalogDatabaseBindingMaterial = {
    version: 1,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    views: SEMANTIC_CATALOG.sources.map(source => ({
      view: source.view,
      database_owner: 'postgres',
      relation_options: source.view_security_barrier ? ['security_barrier=true'] : [],
      definition_sha256: 'a'.repeat(64)
    })),
    principal: {
      role: 'f1ql_answer',
      selectable_relations: SEMANTIC_CATALOG.sources.map(source => source.view),
      writable_relations: []
    },
    database_identity: {
      current_user_sha256: DATABASE_IDENTITY.current_user_sha256,
      current_database_sha256: DATABASE_IDENTITY.current_database_sha256
    },
    required_grain_checks: SEMANTIC_CATALOG.sources.filter(source => source.grain.uniqueness === 'required')
      .map(source => ({ view: source.view, key: [...source.grain.key], duplicate_grain: false }))
  };
  const databaseBindingHash = computeSemanticCatalogDatabaseBindingHash(material);
  const unsigned: UnsignedSemanticCatalogBindingArtifact = {
    version: 1,
    kind: 'f1ql_semantic_catalog_database_binding',
    target: 'production',
    observed_at: CATALOG_TIME,
    commit_sha: COMMIT_SHA,
    deployment_id: DEPLOYMENT_ID,
    release_id: RELEASE_ID,
    catalog_hash: SEMANTIC_CATALOG_HASH,
    database_binding_hash: databaseBindingHash,
    database_target_sha256: DATABASE_TARGET_SHA256,
    binding: { ...material, database_binding_hash: databaseBindingHash },
    read_counters: {
      transaction_count: 1,
      statement_count: 4 + material.required_grain_checks.length,
      required_grain_check_count: material.required_grain_checks.length
    },
    production_evidence: { key_id: 'catalog-production-test-key', algorithm: 'Ed25519' }
  };
  return {
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getSemanticCatalogBindingArtifactSigningPayload(unsigned), catalogKeys.privateKey)
        .toString('base64')
    }
  };
}

function principalAudit(
  currentDatabaseSha256 = DATABASE_IDENTITY.current_database_sha256,
  databaseTargetSha256 = DATABASE_TARGET_SHA256
) {
  const unsigned: UnsignedAnswerPrincipalAuditReport = {
    version: ANSWER_PRINCIPAL_AUDIT_VERSION,
    kind: 'f1ql_answer_principal_audit',
    target: 'production',
    audited_at: PRINCIPAL_TIME,
    commit_sha: COMMIT_SHA,
    deployment_id: DEPLOYMENT_ID,
    release_id: RELEASE_ID,
    current_user_sha256: DATABASE_IDENTITY.current_user_sha256,
    current_database_sha256: currentDatabaseSha256,
    database_target_sha256: databaseTargetSha256,
    assertion_scope: 'answer_principal_least_privilege',
    statement_timeout_ms: ANSWER_PRINCIPAL_AUDIT_TIMEOUT_MS,
    required_relations: ANSWER_PRINCIPAL_REQUIRED_RELATIONS,
    routine_observation_count: 0,
    effective_routine_execute_count: 0,
    status: 'passed',
    findings: [],
    production_evidence: { key_id: 'catalog-production-test-key', algorithm: 'Ed25519' }
  };
  return {
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getAnswerPrincipalAuditSigningPayload(unsigned), catalogKeys.privateKey)
        .toString('base64')
    }
  };
}

function context() {
  return {
    commit_sha: COMMIT_SHA,
    deployment_id: DEPLOYMENT_ID,
    release_id: RELEASE_ID,
    key_id: KEY_ID,
    private_key: evidenceKeys.privateKey,
    catalog_trusted_key: { key_id: 'catalog-production-test-key', public_key: catalogKeys.publicKey },
    capture_trusted_key: { key_id: CAPTURE_KEY_ID, public_key: captureKeys.publicKey },
    expected_provider_identity: PROVIDER,
    capture_nonce: CAPTURE_NONCE,
    answer_database_target_sha256: DATABASE_TARGET_SHA256,
    answer_database_user_sha256: DATABASE_IDENTITY.current_user_sha256,
    answer_database_name_sha256: DATABASE_IDENTITY.current_database_sha256,
    current_user_sha256: DATABASE_IDENTITY.current_user_sha256,
    current_database_sha256: DATABASE_IDENTITY.current_database_sha256
  };
}

function buildEnvironment(): NodeJS.ProcessEnv {
  return {
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_BUILD_ENABLED: 'true',
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_TARGET: 'production',
    RAILWAY_GIT_COMMIT_SHA: COMMIT_SHA,
    F1QL_ANSWER_DEPLOYMENT_ID: DEPLOYMENT_ID,
    F1QL_ANSWER_RELEASE_ID: RELEASE_ID,
    F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID: 'catalog-production-test-key',
    F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64:
      catalogKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_KEY_ID: KEY_ID,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64:
      evidenceKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_NONCE: CAPTURE_NONCE,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_KEY_ID: CAPTURE_KEY_ID,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_CAPTURE_PUBLIC_KEY_BASE64:
      captureKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    F1QL_ANSWER_DATABASE_URL: DATABASE_URL,
    F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER: 'openai-compatible',
    F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY: 'semantic-shadow-production-test-provider-key',
    F1QL_SEMANTIC_CANDIDATE_MODEL: 'test-semantic-model',
    F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA: 'true'
  };
}

function reportEnvironment(): NodeJS.ProcessEnv {
  return {
    RAILWAY_GIT_COMMIT_SHA: COMMIT_SHA,
    F1QL_ANSWER_DEPLOYMENT_ID: DEPLOYMENT_ID,
    F1QL_ANSWER_RELEASE_ID: RELEASE_ID,
    F1QL_ANSWER_DATABASE_URL: DATABASE_URL,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_KEY_ID: KEY_ID,
    F1QL_SEMANTIC_SHADOW_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64:
      evidenceKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

function railwayLog(retained: unknown, timestamp = SHADOW_TIME): string {
  return `${JSON.stringify({ message: JSON.stringify(retained), timestamp, level: 'info' })}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
