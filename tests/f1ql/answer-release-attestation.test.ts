import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAnswerReleaseAttestationFile as buildReleaseAtClock, getAnswerProductionEvidenceSigningPayload, requireEvidenceBackedTemplates } from '../../scripts/build-answer-release-attestation';
import { getAnswerPrincipalAuditSigningPayload } from '../../scripts/audit-answer-principal';
import { verifyAnswerReleaseAttestationFile as verifyReleaseAtClock } from '../../scripts/verify-answer-release-attestation';
import { buildAnswerDerivationReport } from '../../src/f1ql/answer-derivation-report';
import {
  getAnswerDerivationManifestHash,
  getAnswerDeterministicDerivationContractSha256,
  signAnswerDerivationEvidence,
  verifyAnswerDerivationEvidence
} from '../../src/f1ql/answer-derivation-evidence';
import {
  ActiveAnswerReleaseContext,
  ANSWER_RELEASE_DEFAULT_MAX_AGE_MS,
  ANSWER_RELEASE_DEFAULT_MAX_VALIDITY_MS,
  ANSWER_RELEASE_EVIDENCE_HASH_KEYS,
  ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS,
  AnswerReleaseAttestationError,
  answerReleaseTemporalPolicy,
  buildActiveAnswerReleaseBindings,
  getAnswerReleaseAttestationHash,
  getAnswerReleaseAttestationSigningPayload,
  isVerifiedAnswerReleaseAttestation,
  parseAnswerReleaseAttestation,
  verifyAnswerReleaseAttestation,
  verifyVerifiedAnswerReleaseAttestationValidity,
  loadDeterministicAnswerReleaseVerificationInput
} from '../../src/f1ql/answer-release-attestation';
import { ANSWER_INTENT_SCHEMA_VERSION } from '../../src/f1ql/answer-intent';
import { ANSWER_INTENT_DERIVATION_VERSION } from '../../src/f1ql/answer-intent-derivation';
import {
  ANSWER_QUESTION_CONTRACT_VERSION
} from '../../src/f1ql/answer-question';
import { ANSWER_SEMANTIC_PROOF_VERSION } from '../../src/f1ql/answer-semantic-proof';
import { ANSWER_TEMPLATE_IDS, ANSWER_TEMPLATE_REGISTRY_HASH, ANSWER_TEMPLATE_REGISTRY_VERSION } from '../../src/f1ql/answer-templates';
import { getF1QLProgramHash } from '../../src/f1ql/verified-programs';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../fixtures/f1ql-answer-evaluation-manifest';

const hash = (digit: string) => digit.repeat(64);
const runtime = {
  max_concurrency: 2, queue_timeout_ms: 2_000, request_timeout_ms: 12_000, rate_limit_max: 10,
  rate_limit_window_ms: 900_000, statement_timeout_ms: 3_000, max_work_units: 200, max_rows: 100, max_response_bytes: 65_536
};
const evidence = {
  manifest_sha256: hash('8'), artifact_sha256: hash('9'), report_sha256: hash('a'),
  result_fixture_sha256: hash('b'), principal_audit_sha256: hash('c'), production_evidence_sha256: hash('d'),
  semantic_catalog_hash: hash('e'), semantic_catalog_database_binding_hash: hash('f'), semantic_catalog_binding_artifact_sha256: hash('0')
};
const passingStatuses = { semantic: 'pass', safety: 'pass', linker: 'pass' } as const;
const RELEASE_NOW_MS = Date.parse('2026-07-24T00:01:00.000Z');
const CANARY_HMAC_KEY = Buffer.alloc(32, 7);
const CANARY_HMAC_KEY_BASE64 = CANARY_HMAC_KEY.toString('base64');
const CANARY_HMAC_KEY_SHA256 = createHash('sha256').update(CANARY_HMAC_KEY).digest('hex');
const temporalPolicy = { now_ms: RELEASE_NOW_MS, max_validity_ms: 600_000, max_age_ms: 300_000 };
const buildAnswerReleaseAttestationFile = (paths: Parameters<typeof buildReleaseAtClock>[0], env: NodeJS.ProcessEnv) => buildReleaseAtClock(paths, env, RELEASE_NOW_MS);
const verifyAnswerReleaseAttestationFile = (path: string, env: NodeJS.ProcessEnv) => verifyReleaseAtClock(path, env, RELEASE_NOW_MS);
const context = (overrides: Partial<ActiveAnswerReleaseContext> = {}): ActiveAnswerReleaseContext => ({
  release_id: 'test-release-1', issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:10:00.000Z',
  commit_sha: 'e'.repeat(40),
  audience: 'f1muse-answer', deployment_id: 'test-deployment', evidence_hashes: evidence,
  canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 50, canary_hmac_key_sha256: CANARY_HMAC_KEY_SHA256,
  statuses: passingStatuses, runtime, deployment_template_ids: ['final_standings_leader', 'race_date'],
  answer_routing_mode: 'template_only', deployment_capability_profile_ids: [], migrated_template_ids: [],
  deployment_principal_classes: ['internal_canary'],
  ...overrides
});

const trusted = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const trustedKey = { key_id: 'release-key-1', public_key: trusted.publicKey };

function signedFixture(active = context(), privateKey = trusted.privateKey, keyId = trustedKey.key_id) {
  const unsigned = {
    version: 8 as const,
    kind: 'f1ql_answer_release_attestation' as const,
    key_id: keyId,
    ...buildActiveAnswerReleaseBindings(active)
  };
  return {
    ...unsigned,
    signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), privateKey).toString('base64')
  };
}

describe('cryptographically rooted answer release attestation', () => {
  it('keeps conservative defaults while permitting bounded restart-safe public releases', () => {
    expect(answerReleaseTemporalPolicy({}, RELEASE_NOW_MS)).toEqual({
      now_ms: RELEASE_NOW_MS,
      max_validity_ms: ANSWER_RELEASE_DEFAULT_MAX_VALIDITY_MS,
      max_age_ms: ANSWER_RELEASE_DEFAULT_MAX_AGE_MS
    });
    expect(answerReleaseTemporalPolicy({
      F1QL_ANSWER_RELEASE_MAX_VALIDITY_MS: String(ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS),
      F1QL_ANSWER_RELEASE_MAX_AGE_MS: String(ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS)
    }, RELEASE_NOW_MS)).toEqual({
      now_ms: RELEASE_NOW_MS,
      max_validity_ms: ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS,
      max_age_ms: ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS
    });
    expect(() => answerReleaseTemporalPolicy({
      F1QL_ANSWER_RELEASE_MAX_VALIDITY_MS: String(ANSWER_RELEASE_MAX_CONFIGURABLE_TIME_MS + 1)
    }, RELEASE_NOW_MS)).toThrowError(expect.objectContaining({ code: 'release_not_configured' }));
  });

  it('verifies a trusted Ed25519 signature and exact active bindings, then deeply freezes', () => {
    const raw = signedFixture();
    const parsed = parseAnswerReleaseAttestation(raw);
    expect(isVerifiedAnswerReleaseAttestation(parsed)).toBe(false);
    const verified = verifyAnswerReleaseAttestation(raw, trustedKey, context(), temporalPolicy);
    expect(isVerifiedAnswerReleaseAttestation(verified)).toBe(true);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.statuses)).toBe(true);
    expect(Object.isFrozen(verified.allowed_template_ids)).toBe(true);
    expect(Object.isFrozen(verified.allowed_principal_classes)).toBe(true);
    expect(verified).toMatchObject({ derivation_version: ANSWER_INTENT_DERIVATION_VERSION, deterministic_derivation_contract_sha256: getAnswerDeterministicDerivationContractSha256(), canary_policy_version: 'answer-canary-hmac-v1', maximum_canary_stage: 50, canary_hmac_key_sha256: CANARY_HMAC_KEY_SHA256 });
    expect(getAnswerReleaseAttestationHash(verified)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => { (verified.statuses as { semantic: string }).semantic = 'fail'; }).toThrow();
  });

  it('rejects tampering, a wrong trusted key, and a self-authored artifact', () => {
    const raw = signedFixture();
    expect(() => verifyAnswerReleaseAttestation({ ...raw, derivation_version: 'tampered-version' }, trustedKey, context(), temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'invalid_attestation' })
    );
    expect(() => verifyAnswerReleaseAttestation({ ...raw, deterministic_derivation_contract_sha256: hash('2') }, trustedKey, context(), temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'signature_invalid' })
    );
    expect(() => verifyAnswerReleaseAttestation(raw, { ...trustedKey, public_key: other.publicKey }, context(), temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'signature_invalid' })
    );
    const selfAuthored = signedFixture(context(), other.privateKey, 'attacker-key');
    expect(() => verifyAnswerReleaseAttestation(selfAuthored, trustedKey, context(), temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'signature_invalid' })
    );
  });

  it('does not transfer module authority through parsed or copied objects', () => {
    const verified = verifyAnswerReleaseAttestation(signedFixture(), trustedKey, context(), temporalPolicy);
    const copy = { ...verified };
    expect(isVerifiedAnswerReleaseAttestation(copy)).toBe(false);
    expect(() => getAnswerReleaseAttestationHash(copy as never)).toThrowError(expect.objectContaining({ code: 'invalid_attestation' }));
    expect(isVerifiedAnswerReleaseAttestation(parseAnswerReleaseAttestation(copy))).toBe(false);
  });

  it('rechecks current validity without reparsing or transferring the verified brand', () => {
    const verified = verifyAnswerReleaseAttestation(signedFixture(), trustedKey, context(), temporalPolicy);
    expect(verifyVerifiedAnswerReleaseAttestationValidity(verified, RELEASE_NOW_MS)).toBe(verified);
    expect(() => verifyVerifiedAnswerReleaseAttestationValidity(verified, Date.parse(verified.expires_at))).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
    expect(() => verifyVerifiedAnswerReleaseAttestationValidity({ ...verified } as never, RELEASE_NOW_MS)).toThrowError(
      expect.objectContaining({ code: 'invalid_attestation' })
    );
  });

  it('binds every active code, evidence, deployment, runtime, and allowlist value', () => {
    const raw = signedFixture();
    for (const changed of [
      context({ commit_sha: 'f'.repeat(40) }),
      context({ release_id: 'other-release' }),
      context({ audience: 'other-audience' }),
      context({ deployment_id: 'other-deployment' }),
      context({ maximum_canary_stage: 25 }),
      context({ canary_hmac_key_sha256: hash('f') }),
      context({ evidence_hashes: { ...evidence, report_sha256: hash('f') } }),
      context({ runtime: { ...runtime, max_rows: 99 } }),
      context({ deployment_template_ids: ['race_date'] }),
      context({ answer_routing_mode: 'shadow_compare', deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      context({ answer_routing_mode: 'compositional_profiles', deployment_capability_profile_ids: ['semantic-single-source-v1'] }),
      context({ deployment_principal_classes: ['public'] })
    ]) {
      expect(() => verifyAnswerReleaseAttestation(raw, trustedKey, changed, temporalPolicy)).toThrowError(expect.objectContaining({ code: 'binding_mismatch' }));
    }
    const bindings = buildActiveAnswerReleaseBindings(context());
    expect(bindings.derivation_version_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings.intent_schema_version_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bindings.authorization_version_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects an independently signed deterministic derivation contract mismatch', () => {
    const active = context();
    const unsigned = {
      version: 8 as const,
      kind: 'f1ql_answer_release_attestation' as const,
      key_id: trustedKey.key_id,
      ...buildActiveAnswerReleaseBindings(active),
      deterministic_derivation_contract_sha256: hash('f')
    };
    const raw = { ...unsigned, signature: sign(null, getAnswerReleaseAttestationSigningPayload(unsigned), trusted.privateKey).toString('base64') };
    expect(() => verifyAnswerReleaseAttestation(raw, trustedKey, active, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
  });

  it('enforces signed issuance, expiry, maximum validity, and freshness with an injected clock', () => {
    const stale = context({ issued_at: '2026-07-23T23:50:00.000Z', expires_at: '2026-07-24T00:05:00.000Z' });
    expect(() => verifyAnswerReleaseAttestation(signedFixture(stale), trustedKey, stale, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
    const expired = context({ issued_at: '2026-07-23T23:59:00.000Z', expires_at: '2026-07-24T00:01:00.000Z' });
    expect(() => verifyAnswerReleaseAttestation(signedFixture(expired), trustedKey, expired, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
    const tooLong = context({ issued_at: '2026-07-24T00:00:00.000Z', expires_at: '2026-07-24T00:20:00.000Z' });
    expect(() => verifyAnswerReleaseAttestation(signedFixture(tooLong), trustedKey, tooLong, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
    const future = context({ issued_at: '2026-07-24T00:02:00.000Z', expires_at: '2026-07-24T00:10:00.000Z' });
    expect(() => verifyAnswerReleaseAttestation(signedFixture(future), trustedKey, future, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'binding_mismatch' })
    );
  });

  it('rejects non-pass trusted status, invalid runtime, malformed signatures, and unknown fields', () => {
    const failedContext = context({ statuses: { ...passingStatuses, semantic: 'fail' } });
    expect(() => verifyAnswerReleaseAttestation(signedFixture(failedContext), trustedKey, failedContext, temporalPolicy)).toThrowError(
      expect.objectContaining({ code: 'release_gate_failed' })
    );
    expect(() => buildActiveAnswerReleaseBindings(context({ runtime: { ...runtime, max_concurrency: 17 } }))).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), signature: 'not-base64' })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), signature: nonCanonicalAlias(signedFixture().signature) })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), signature: `${signedFixture().signature}\n` })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), extra: true })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), version: 5 })).toThrow(AnswerReleaseAttestationError);
    for (const allowed_principal_classes of [[], ['public', 'internal'], ['public', 'public'], ['unknown']]) {
      expect(() => parseAnswerReleaseAttestation({ ...signedFixture(), allowed_principal_classes })).toThrow(AnswerReleaseAttestationError);
    }
    expect(() => parseAnswerReleaseAttestation({
      ...signedFixture(), allowed_capability_profile_ids: ['semantic-single-source-v1']
    })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({
      ...signedFixture(), answer_routing_mode: 'compositional_profiles'
    })).toThrow(AnswerReleaseAttestationError);
    expect(() => parseAnswerReleaseAttestation({
      ...signedFixture(), migrated_template_ids: ['race_date']
    })).toThrow(AnswerReleaseAttestationError);
  });

  it('loads deterministic production context without a provider credential', () => {
    const productionContext = context();
    const raw = signedFixture(productionContext);
    const env: NodeJS.ProcessEnv = {
      F1QL_ANSWER_RELEASE_ATTESTATION: JSON.stringify(raw),
      F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64: trusted.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      F1QL_ANSWER_RELEASE_KEY_ID: trustedKey.key_id,
      F1QL_ANSWER_RELEASE_ID: productionContext.release_id,
      GIT_COMMIT_SHA: productionContext.commit_sha,
      F1QL_ANSWER_AUTHORIZATION_AUDIENCE: productionContext.audience,
      F1QL_ANSWER_DEPLOYMENT_ID: productionContext.deployment_id,
      F1QL_ANSWER_DEPLOYMENT_TEMPLATE_IDS: productionContext.deployment_template_ids.join(','),
      F1QL_ANSWER_ROUTING_MODE: productionContext.answer_routing_mode,
      F1QL_ANSWER_DEPLOYMENT_CAPABILITY_PROFILE_IDS: productionContext.deployment_capability_profile_ids.join(','),
      F1QL_ANSWER_MIGRATED_TEMPLATE_IDS: productionContext.migrated_template_ids.join(','),
      F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES: productionContext.deployment_principal_classes.join(','),
      F1QL_ANSWER_CANARY_MAXIMUM_STAGE: String(productionContext.maximum_canary_stage),
      F1QL_ANSWER_CANARY_HMAC_KEY_BASE64: CANARY_HMAC_KEY_BASE64,
    };
    for (const [key, value] of Object.entries(evidence)) {
      env[`F1QL_ANSWER_RELEASE_${key.toUpperCase()}`] = value;
    }
    const config = {
      maxConcurrency: runtime.max_concurrency, queueTimeoutMs: runtime.queue_timeout_ms,
      requestTimeoutMs: runtime.request_timeout_ms, rateLimitMax: runtime.rate_limit_max,
      rateLimitWindowMs: runtime.rate_limit_window_ms, statementTimeoutMs: runtime.statement_timeout_ms,
      maxWorkUnits: runtime.max_work_units, maxRows: runtime.max_rows, maxResponseBytes: runtime.max_response_bytes
    };
    const loaded = loadDeterministicAnswerReleaseVerificationInput(config, env, RELEASE_NOW_MS);
    expect(loaded.active_context).not.toHaveProperty('provider');
    expect(verifyAnswerReleaseAttestation(loaded.raw_attestation, loaded.trusted_key, loaded.active_context, loaded.temporal_policy).derivation_version).toBe(ANSWER_INTENT_DERIVATION_VERSION);
    const loadedAfterCliDeploy = loadDeterministicAnswerReleaseVerificationInput(config, {
      ...env,
      RAILWAY_GIT_COMMIT_SHA: 'f'.repeat(40)
    }, RELEASE_NOW_MS);
    expect(loadedAfterCliDeploy.active_context.commit_sha).toBe(productionContext.commit_sha);
    expect(verifyAnswerReleaseAttestation(
      loadedAfterCliDeploy.raw_attestation,
      loadedAfterCliDeploy.trusted_key,
      loadedAfterCliDeploy.active_context,
      loadedAfterCliDeploy.temporal_policy
    ).commit_sha).toBe(productionContext.commit_sha);
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64: `${env.F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64}\n` })).toThrow();
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_CANARY_MAXIMUM_STAGE: '10' })).toThrow();
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_CANARY_MAXIMUM_STAGE: '050' })).toThrow();
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_CANARY_HMAC_KEY_BASE64: `${CANARY_HMAC_KEY_BASE64}\n` })).toThrow();
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES: undefined })).toThrow();
    expect(() => loadDeterministicAnswerReleaseVerificationInput(config, { ...env, F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES: 'public,internal_canary' })).toThrow();
  });
});

describe('guarded answer release attestation files', () => {
  it('builds mode-0600 from passing bound evidence and verifies the active release', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv, publicKey }) => {
      const built = buildAnswerReleaseAttestationFile(paths, buildEnv);
      expect(built).toMatchObject({ output: paths.output, status: 'pass' });
      expect(statSync(paths.output).mode & 0o777).toBe(0o600);
      const attestation = JSON.parse(readFileSync(paths.output, 'utf8'));
      expect(attestation.allowed_principal_classes).toEqual(['internal_canary']);
      expect(verifyAnswerReleaseAttestationFile(paths.output, verificationEnv(buildEnv, publicKey, attestation))).toEqual({
        status: 'pass', sha256: built.sha256, key_id: 'release-key-1'
      });
    });
  });

  it('allows an evidence-backed subset of templates to be deployed', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const built = buildAnswerReleaseAttestationFile(paths, {
        ...buildEnv,
        F1QL_ANSWER_DEPLOYMENT_TEMPLATE_IDS: 'final_standings_leader'
      });
      const attestation = JSON.parse(readFileSync(built.output, 'utf8'));
      expect(attestation.allowed_template_ids).toEqual(['final_standings_leader']);
    });
  });

  it('does not sign compositional routing before profile-specific release evidence exists', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      expect(() => buildAnswerReleaseAttestationFile(paths, {
        ...buildEnv,
        F1QL_ANSWER_ROUTING_MODE: 'compositional_profiles',
        F1QL_ANSWER_DEPLOYMENT_CAPABILITY_PROFILE_IDS: 'semantic-single-source-v1'
      })).toThrow('answer_release_compositional_evidence_unavailable');
    });
  });

  it('rejects a deployed template absent from signed evidence', () => {
    expect(() => requireEvidenceBackedTemplates(['final_standings_leader'], new Set(['race_date'])))
      .toThrow('answer_release_template_not_deployed');
  });

  it('requires an explicit canonical deployment principal allowlist', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      for (const value of [undefined, '', 'public,internal_canary', 'public,public', 'unknown']) {
        expect(() => buildAnswerReleaseAttestationFile(paths, {
          ...buildEnv,
          F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES: value
        })).toThrow('answer_release_principal_allowlist_invalid');
      }
    });
  });

  it('rejects a failed report, provider report, and artifact/report mismatch', () => {
    const failedArtifact = makePassingArtifact();
    failedArtifact.observations[0] = { ...failedArtifact.observations[0], reason: 'race_classification' };
    withReleaseFiles(failedArtifact, ({ paths, buildEnv }) => {
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_report_failed');
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const report = JSON.parse(readFileSync(paths.report, 'utf8'));
      report.evidence.artifact_sha256 = '0'.repeat(64);
      writeFileSync(paths.report, `${JSON.stringify(report)}\n`);
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_report_mismatch');
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      writeFileSync(paths.report, '{"version":3,"kind":"f1ql_answer_observation_report"}\n');
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_report_mismatch');
    });
    const driftedArtifact = makePassingArtifact();
    const answer = driftedArtifact.observations.find((item: any) => item.action === 'answer');
    answer.program_hash = 'f'.repeat(64);
    withReleaseFiles(driftedArtifact, ({ paths, buildEnv }) => {
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_report_failed');
    });
  });

  it('rejects provider observation evidence and empty evidence', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const providerArtifact = { version: 4, kind: 'f1ql_answer_observations' };
      writeFileSync(paths.artifact, `${JSON.stringify(providerArtifact)}\n`);
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
      writeFileSync(paths.principal_audit, '');
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_input_invalid');
    });
  });

  it('requires a trusted signed evaluation artifact', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const artifact = JSON.parse(readFileSync(paths.artifact, 'utf8'));
      artifact.observations[0].reason = 'race_classification';
      writeFileSync(paths.artifact, `${JSON.stringify(artifact)}\n`);
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_derivation_signature_invalid');
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const wrong = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      expect(() => buildAnswerReleaseAttestationFile(paths, { ...buildEnv, F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64: wrong })).toThrow('answer_derivation_signature_invalid');
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      expect(() => buildAnswerReleaseAttestationFile(paths, { ...buildEnv, F1QL_ANSWER_RELEASE_PRIVATE_KEY_BASE64: `${buildEnv.F1QL_ANSWER_RELEASE_PRIVATE_KEY_BASE64}\n` })).toThrow('answer_release_signing_key_invalid');
      expect(() => buildAnswerReleaseAttestationFile(paths, { ...buildEnv, F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64: `${buildEnv.F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64} ` })).toThrow('answer_release_environment_invalid');
    });
  });

  it('refuses provider observation evidence for a new release', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      writeFileSync(paths.artifact, '{"version":4,"kind":"f1ql_answer_observations"}\n');
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
    });
  });

  it('rejects stale derivation and principal evidence using explicit max ages and an injected clock', () => {
    const staleArtifact = makePassingArtifact();
    staleArtifact.collected_at = '2026-07-23T23:00:00.000Z';
    withReleaseFiles(staleArtifact, ({ paths, buildEnv }) => {
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_derivation_evidence_stale');
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv, productionPrivateKey, productionKeyId }) => {
      const staleAudit = passingPrincipalAudit(productionPrivateKey, productionKeyId, { audited_at: '2026-07-23T23:00:00.000Z' });
      writeFileSync(paths.principal_audit, `${JSON.stringify(staleAudit)}\n`);
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_principal_audit_stale');
    });
  });

  it('requires the exact successful principal audit contract', () => {
    const invalidAudits = [
      '{"status":"passed"}\n',
      'not-json',
      JSON.stringify({ ...passingPrincipalAudit(), status: 'attention' }),
      JSON.stringify({ ...passingPrincipalAudit(), findings: ['unexpected_select:public.driver'] }),
      JSON.stringify({ ...passingPrincipalAudit(), statement_timeout_ms: 20_000 }),
      JSON.stringify({ ...passingPrincipalAudit(), required_relations: ['f1ql.driver_standings'] })
    ];
    for (const invalid of invalidAudits) {
      withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
        writeFileSync(paths.principal_audit, invalid);
        expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
      });
    }
  });

  it('requires production evidence bound to commit, deployment, audit, migrations, and deployed release', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const evidence = JSON.parse(readFileSync(paths.production_evidence, 'utf8'));
      for (const changed of [
        { ...evidence, version: 1 },
        { ...evidence, kind: 'placeholder' },
        { ...evidence, status: 'attention' },
        { ...evidence, commit_sha: 'f'.repeat(40) },
        { ...evidence, deployment_id: 'other-deployment' },
        { ...evidence, principal_audit_sha256: '0'.repeat(64) },
        { ...evidence, current_user_sha256: '3'.repeat(64) },
        { ...evidence, current_database_sha256: '4'.repeat(64) },
        { ...evidence, identity_view_migration_sha256: '1'.repeat(64) },
        { ...evidence, qualifying_view_migration_sha256: '1'.repeat(64) },
        { ...evidence, role_grant_migration_sha256: '2'.repeat(64) },
        { ...evidence, semantic_catalog_hash: '3'.repeat(64) },
        { ...evidence, semantic_catalog_database_binding_hash: '4'.repeat(64) },
        { ...evidence, semantic_catalog_binding_artifact_sha256: '5'.repeat(64) },
        { ...evidence, release_id: 'other-release' },
        { ...evidence, production_evidence: { ...evidence.production_evidence, key_id: 'wrong-key' } }
      ]) {
        writeFileSync(paths.production_evidence, `${JSON.stringify(changed)}\n`);
        expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_production_evidence_invalid');
      }
      const aliased = { ...evidence, production_evidence: { ...evidence.production_evidence, signature: nonCanonicalAlias(evidence.production_evidence.signature) } };
      writeFileSync(paths.production_evidence, `${JSON.stringify(aliased)}\n`);
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_production_evidence_invalid');
      writeFileSync(paths.production_evidence, '{"status":"passed"}\n');
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
      writeFileSync(paths.production_evidence, 'not-json');
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
    });
  });

  it('requires byte-exact complete real-emitter results', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv }) => {
      const committed = readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json', 'utf8');
      const mutations = [
        (fixture: any) => { fixture[0].envelope.rows[0].points = 'tampered'; },
        (fixture: any) => { fixture[0].envelope.rendering = 'tampered'; },
        (fixture: any) => { fixture[0].envelope.metadata.fact_space_version = 'tampered'; }
      ];
      for (const mutate of mutations) {
        const fixture = JSON.parse(committed);
        mutate(fixture);
        writeFileSync(paths.result_fixture, `${JSON.stringify(fixture, null, 2)}\n`);
        expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_result_fixture_mismatch');
      }
    });
  });

  it('rejects trusted signatures over wrong identity bindings and arbitrary migration hashes', () => {
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv, productionPrivateKey, productionKeyId }) => {
      for (const field of ['current_user_sha256', 'current_database_sha256'] as const) {
        const audit = passingPrincipalAudit(productionPrivateKey, productionKeyId, { [field]: 'f'.repeat(64) });
        writeFileSync(paths.principal_audit, `${JSON.stringify(audit)}\n`);
        expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
      }
    });
    withReleaseFiles(makePassingArtifact(), ({ paths, buildEnv, productionPrivateKey }) => {
      const evidence = JSON.parse(readFileSync(paths.production_evidence, 'utf8'));
      for (const field of ['identity_view_migration_sha256', 'qualifying_view_migration_sha256', 'role_grant_migration_sha256', 'semantic_catalog_hash']) {
        const unsigned = { ...evidence, [field]: 'f'.repeat(64), production_evidence: { key_id: evidence.production_evidence.key_id, algorithm: 'Ed25519' } };
        const resigned = { ...unsigned, production_evidence: { ...unsigned.production_evidence, signature: sign(null, getAnswerProductionEvidenceSigningPayload(unsigned), productionPrivateKey).toString('base64') } };
        writeFileSync(paths.production_evidence, `${JSON.stringify(resigned)}\n`);
        expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow('answer_release_production_evidence_invalid');
      }
    });
  });

  it('rejects wrong verification keys, stale commits, symlinks, and existing output paths', () => {
    withReleaseFiles(makePassingArtifact(), ({ directory, paths, buildEnv, publicKey }) => {
      expect(() => buildAnswerReleaseAttestationFile({ ...paths, output: join(directory, 'stale-output.json') }, { ...buildEnv, GIT_COMMIT_SHA: 'f'.repeat(40) })).toThrow('answer_release_commit_mismatch');
      buildAnswerReleaseAttestationFile(paths, buildEnv);
      const attestation = JSON.parse(readFileSync(paths.output, 'utf8'));
      const active = verificationEnv(buildEnv, publicKey, attestation);
      const wrong = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      expect(() => verifyAnswerReleaseAttestationFile(paths.output, { ...active, F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64: wrong })).toThrow();
      expect(() => verifyAnswerReleaseAttestationFile(paths.output, { ...active, GIT_COMMIT_SHA: 'f'.repeat(40) })).toThrow();

      const linkedArtifact = join(directory, 'artifact-link.json');
      symlinkSync(paths.artifact, linkedArtifact);
      expect(() => buildAnswerReleaseAttestationFile({ ...paths, artifact: linkedArtifact, output: join(directory, 'linked-output.json') }, buildEnv)).toThrow();
      expect(() => buildAnswerReleaseAttestationFile(paths, buildEnv)).toThrow();
    });
  });
});

function makePassingArtifact(): any {
  return {
    version: 1,
    kind: 'f1ql_answer_derivation_evidence',
    collected_at: '2026-07-24T00:00:00.000Z',
    manifest: { case_count: answerEvaluationManifest.length, sha256: getAnswerDerivationManifestHash(answerEvaluationManifest) },
    contract: {
      question_version: ANSWER_QUESTION_CONTRACT_VERSION,
      derivation_version: ANSWER_INTENT_DERIVATION_VERSION,
      intent_schema_version: ANSWER_INTENT_SCHEMA_VERSION,
      template_version: ANSWER_TEMPLATE_REGISTRY_VERSION,
      template_registry_hash: ANSWER_TEMPLATE_REGISTRY_HASH,
      proof_version: ANSWER_SEMANTIC_PROOF_VERSION
    },
    observations: answerEvaluationManifest.map(item => {
      const answer = item.expected.action === 'answer';
      const program = item.expected.acceptable_programs?.[0];
      return {
        id: item.id,
        action: item.expected.action,
        reason: item.expected.reason,
        ...(answer ? {
          template_id: item.expected.template_id,
          proof_hash: createHash('sha256').update(`proof:${item.id}`).digest('hex'),
          program_hash: getF1QLProgramHash(program!)
        } : {}),
        entity_candidates: item.canonical_entities,
        linked_entities: answer ? item.canonical_entities : []
      };
    })
  };
}

function nonCanonicalAlias(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = alphabet.indexOf(value.at(-3)!);
  return `${value.slice(0, -3)}${alphabet[index + 1]}==`;
}

function withReleaseFiles(
  artifactInput: any,
  run: (fixture: { directory: string; paths: any; buildEnv: NodeJS.ProcessEnv; publicKey: string; productionPrivateKey: any; productionKeyId: string }) => void
): void {
  const directory = mkdtempSync(join(tmpdir(), 'answer-release-'));
  try {
    const paths = {
      artifact: join(directory, 'artifact.json'),
      report: join(directory, 'report.json'),
      result_fixture: join(directory, 'results.json'),
      principal_audit: join(directory, 'principal.json'),
      production_evidence: join(directory, 'production.json'),
      output: join(directory, 'attestation.json')
    };
    const evaluationKeys = generateKeyPairSync('ed25519');
    const signer = {
      key_id: 'evaluation-key-1',
      private_key_base64: evaluationKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    };
    const signedArtifact = signAnswerDerivationEvidence(answerEvaluationManifest, artifactInput, signer);
    const artifactBytes = Buffer.from(`${JSON.stringify(signedArtifact)}\n`);
    writeFileSync(paths.artifact, artifactBytes);
    const evaluationPublicKey = evaluationKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const artifact = verifyAnswerDerivationEvidence(answerEvaluationManifest, signedArtifact, {
      key_id: signer.key_id,
      public_key_base64: evaluationPublicKey
    });
    const report = buildAnswerDerivationReport(
      answerEvaluationManifest,
      answerMetamorphicGroups,
      artifact,
      createHash('sha256').update(artifactBytes).digest('hex')
    );
    writeFileSync(paths.report, `${JSON.stringify(report)}\n`);
    writeFileSync(paths.result_fixture, readFileSync('tests/fixtures/f1ql-answer-evaluation-results.json'));
    const productionKeys = generateKeyPairSync('ed25519');
    const productionKeyId = 'production-evidence-key-1';
    const principal = passingPrincipalAudit(productionKeys.privateKey, productionKeyId);
    const principalBytes = Buffer.from(`${JSON.stringify(principal)}\n`);
    writeFileSync(paths.principal_audit, principalBytes);
    const identityMigrationHash = createHash('sha256').update(readFileSync('migrations/20260730_normalize_f1ql_answer_identity_driver_ids.sql')).digest('hex');
    const qualifyingMigrationHash = createHash('sha256').update(readFileSync('migrations/20260730_filter_f1ql_qualifying_classification.sql')).digest('hex');
    const roleGrantMigrationHash = createHash('sha256').update(readFileSync('migrations/20260730_f1ql_answer_role_grants.sql')).digest('hex');
    const unsignedProductionEvidence = {
      version: 3,
      kind: 'f1ql_answer_production_evidence',
      target: 'production',
      status: 'passed',
      commit_sha: 'e'.repeat(40),
      deployment_id: 'test-deployment',
      release_id: 'test-release-1',
      principal_audit_sha256: createHash('sha256').update(principalBytes).digest('hex'),
      current_user_sha256: principal.current_user_sha256,
      current_database_sha256: principal.current_database_sha256,
      identity_view_migration_sha256: identityMigrationHash,
      qualifying_view_migration_sha256: qualifyingMigrationHash,
      role_grant_migration_sha256: roleGrantMigrationHash,
      semantic_catalog_hash: SEMANTIC_CATALOG_HASH,
      semantic_catalog_database_binding_hash: '3'.repeat(64),
      semantic_catalog_binding_artifact_sha256: '4'.repeat(64),
      production_evidence: { key_id: productionKeyId, algorithm: 'Ed25519' }
    } as const;
    writeFileSync(paths.production_evidence, `${JSON.stringify({
      ...unsignedProductionEvidence,
      production_evidence: {
        ...unsignedProductionEvidence.production_evidence,
        signature: sign(null, getAnswerProductionEvidenceSigningPayload(unsignedProductionEvidence), productionKeys.privateKey).toString('base64')
      }
    })}\n`);
    const keys = generateKeyPairSync('ed25519');
    const buildEnv: NodeJS.ProcessEnv = {
      F1QL_ANSWER_RELEASE_BUILD_ENABLED: 'true',
      F1QL_ANSWER_RELEASE_BUILD_TARGET: 'release',
      F1QL_ANSWER_RELEASE_COMMIT_SHA: 'e'.repeat(40),
      GIT_COMMIT_SHA: 'e'.repeat(40),
      F1QL_ANSWER_RELEASE_PRIVATE_KEY_BASE64: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      F1QL_ANSWER_RELEASE_KEY_ID: 'release-key-1',
      F1QL_ANSWER_EVALUATION_KEY_ID: signer.key_id,
      F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64: evaluationPublicKey,
      F1QL_ANSWER_RELEASE_ID: 'test-release-1',
      F1QL_ANSWER_CANARY_MAXIMUM_STAGE: '50',
      F1QL_ANSWER_CANARY_HMAC_KEY_BASE64: CANARY_HMAC_KEY_BASE64,
      F1QL_ANSWER_DERIVATION_EVIDENCE_MAX_AGE_MS: '300000',
      F1QL_ANSWER_PRINCIPAL_AUDIT_MAX_AGE_MS: '300000',
      F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID: productionKeyId,
      F1QL_ANSWER_PRODUCTION_EVIDENCE_PUBLIC_KEY_BASE64: productionKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      F1QL_ANSWER_AUTHORIZATION_AUDIENCE: 'f1muse-answer',
      F1QL_ANSWER_DEPLOYMENT_ID: 'test-deployment',
      F1QL_ANSWER_DEPLOYMENT_TEMPLATE_IDS: ANSWER_TEMPLATE_IDS.join(','),
      F1QL_ANSWER_ROUTING_MODE: 'template_only',
      F1QL_ANSWER_DEPLOYMENT_CAPABILITY_PROFILE_IDS: '',
      F1QL_ANSWER_MIGRATED_TEMPLATE_IDS: '',
      F1QL_ANSWER_DEPLOYMENT_PRINCIPAL_CLASSES: 'internal_canary'
    };
    run({
      directory,
      paths,
      buildEnv,
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      productionPrivateKey: productionKeys.privateKey,
      productionKeyId
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function passingPrincipalAudit(privateKey = generateKeyPairSync('ed25519').privateKey, keyId = 'production-evidence-key-1', overrides: Record<string, unknown> = {}) {
  const unsigned = {
    version: 4,
    kind: 'f1ql_answer_principal_audit',
    target: 'production',
    audited_at: '2026-07-24T00:00:00.000Z',
    commit_sha: 'e'.repeat(40),
    deployment_id: 'test-deployment',
    release_id: 'test-release-1',
    current_user_sha256: '1'.repeat(64),
    current_database_sha256: '2'.repeat(64),
    status: 'passed',
    assertion_scope: 'answer_principal_least_privilege',
    statement_timeout_ms: 5_000,
    required_relations: [
      'f1ql.driver_standings',
      'f1ql.event_classification',
      'f1ql.qualifying_classification',
      'f1ql.event_metadata',
      'f1ql.answer_driver_identity',
      'f1ql.answer_event_identity',
      'f1ql.answer_season_participation'
    ] as const,
    routine_observation_count: 12,
    effective_routine_execute_count: 0,
    findings: [] as string[],
    production_evidence: { key_id: keyId, algorithm: 'Ed25519' as const },
    ...overrides
  } as const;
  return {
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getAnswerPrincipalAuditSigningPayload(unsigned), privateKey).toString('base64')
    }
  };
}

function verificationEnv(buildEnv: NodeJS.ProcessEnv, publicKey: string, attestation: Record<string, any>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildEnv,
    F1QL_ANSWER_RELEASE_PRIVATE_KEY_BASE64: undefined,
    F1QL_ANSWER_RELEASE_PUBLIC_KEY_BASE64: publicKey,
    GIT_COMMIT_SHA: attestation.commit_sha
  };
  for (const key of ANSWER_RELEASE_EVIDENCE_HASH_KEYS) {
    env[`F1QL_ANSWER_RELEASE_${key.toUpperCase()}`] = attestation[key];
  }
  return env;
}
