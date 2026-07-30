import { createHash, createPrivateKey, KeyObject, sign, verify } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { Pool } from 'pg';
import { z } from 'zod';
import { buildAnswerDatabasePoolConfig } from '../src/db/answer-database';
import { isLoopbackHostname } from '../src/db/network-target';
import {
  buildSemanticCatalogDatabaseBinding,
  parseSemanticCatalogDatabaseBinding,
  SemanticCatalogDatabaseBinding,
  SEMANTIC_CATALOG_HASH
} from '../src/f1ql/semantic-catalog';

const COMMIT_SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

const artifactSchema = z.object({
  version: z.literal(1),
  kind: z.literal('f1ql_semantic_catalog_database_binding'),
  target: z.literal('production'),
  observed_at: z.string().datetime(),
  commit_sha: z.string().regex(COMMIT_SHA),
  deployment_id: z.string().regex(IDENTIFIER),
  release_id: z.string().regex(IDENTIFIER),
  catalog_hash: z.string().regex(SHA256),
  database_binding_hash: z.string().regex(SHA256),
  binding: z.unknown(),
  production_evidence: z.object({
    key_id: z.string().regex(IDENTIFIER),
    algorithm: z.literal('Ed25519'),
    signature: z.string().regex(SIGNATURE)
  }).strict()
}).strict();

export interface SemanticCatalogBindingArtifact {
  readonly version: 1;
  readonly kind: 'f1ql_semantic_catalog_database_binding';
  readonly target: 'production';
  readonly observed_at: string;
  readonly commit_sha: string;
  readonly deployment_id: string;
  readonly release_id: string;
  readonly catalog_hash: string;
  readonly database_binding_hash: string;
  readonly binding: SemanticCatalogDatabaseBinding;
  readonly production_evidence: {
    readonly key_id: string;
    readonly algorithm: 'Ed25519';
    readonly signature: string;
  };
}

export type UnsignedSemanticCatalogBindingArtifact = Omit<SemanticCatalogBindingArtifact, 'production_evidence'> & {
  readonly production_evidence: { readonly key_id: string; readonly algorithm: 'Ed25519' };
};

export interface SemanticCatalogAuditContext {
  readonly commit_sha: string;
  readonly deployment_id: string;
  readonly release_id: string;
  readonly key_id: string;
  readonly private_key: KeyObject;
}

export interface TrustedSemanticCatalogAuditKey {
  readonly key_id: string;
  readonly public_key: KeyObject;
}

export function parseSemanticCatalogBindingArtifact(input: unknown): SemanticCatalogBindingArtifact {
  const artifact = artifactSchema.parse(input);
  const binding = parseSemanticCatalogDatabaseBinding(artifact.binding);
  if (artifact.catalog_hash !== SEMANTIC_CATALOG_HASH || artifact.catalog_hash !== binding.catalog_hash ||
      artifact.database_binding_hash !== binding.database_binding_hash) {
    throw new Error('semantic catalog binding artifact mismatch');
  }
  return Object.freeze({ ...artifact, binding });
}

export function getSemanticCatalogBindingArtifactSigningPayload(input: unknown): Buffer {
  const value = input as Record<string, unknown>;
  const rawEvidence = value?.production_evidence as Record<string, unknown> | undefined;
  const candidate = artifactSchema.parse({
    ...value,
    production_evidence: {
      ...rawEvidence,
      signature: rawEvidence?.signature ?? `${'A'.repeat(86)}==`
    }
  });
  const productionEvidence = { key_id: candidate.production_evidence.key_id, algorithm: candidate.production_evidence.algorithm };
  return Buffer.from(stableSerialize({ ...candidate, production_evidence: productionEvidence }), 'utf8');
}

export function verifySemanticCatalogBindingArtifact(
  input: unknown,
  trustedKey: TrustedSemanticCatalogAuditKey,
  expected: Pick<SemanticCatalogBindingArtifact, 'commit_sha' | 'deployment_id' | 'release_id'>
): SemanticCatalogBindingArtifact {
  const artifact = parseSemanticCatalogBindingArtifact(input);
  if (artifact.production_evidence.key_id !== trustedKey.key_id || artifact.commit_sha !== expected.commit_sha ||
      artifact.deployment_id !== expected.deployment_id || artifact.release_id !== expected.release_id ||
      trustedKey.public_key.type !== 'public' || trustedKey.public_key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, getSemanticCatalogBindingArtifactSigningPayload(artifact), trustedKey.public_key,
        decodeCanonicalSignature(artifact.production_evidence.signature))) {
    throw new Error('semantic catalog binding artifact signature or context mismatch');
  }
  return artifact;
}

export async function auditSemanticCatalogBinding(
  database: Pick<Pool, 'connect'>,
  context: SemanticCatalogAuditContext,
  observedAt = new Date().toISOString()
): Promise<SemanticCatalogBindingArtifact> {
  if (!COMMIT_SHA.test(context.commit_sha) || !IDENTIFIER.test(context.deployment_id) || !IDENTIFIER.test(context.release_id) ||
      !IDENTIFIER.test(context.key_id) || context.private_key.type !== 'private' || context.private_key.asymmetricKeyType !== 'ed25519') {
    throw new Error('semantic catalog production audit context is invalid');
  }
  const binding = await buildSemanticCatalogDatabaseBinding(database);
  const unsigned: UnsignedSemanticCatalogBindingArtifact = {
    version: 1,
    kind: 'f1ql_semantic_catalog_database_binding',
    target: 'production',
    observed_at: observedAt,
    commit_sha: context.commit_sha,
    deployment_id: context.deployment_id,
    release_id: context.release_id,
    catalog_hash: binding.catalog_hash,
    database_binding_hash: binding.database_binding_hash,
    binding,
    production_evidence: { key_id: context.key_id, algorithm: 'Ed25519' }
  };
  return parseSemanticCatalogBindingArtifact({
    ...unsigned,
    production_evidence: {
      ...unsigned.production_evidence,
      signature: sign(null, getSemanticCatalogBindingArtifactSigningPayload(unsigned), context.private_key).toString('base64')
    }
  });
}

export async function writeSemanticCatalogBindingAudit(output: string, env: NodeJS.ProcessEnv = process.env): Promise<{ output: string; status: 'pass'; sha256: string }> {
  if (env.F1QL_SEMANTIC_CATALOG_AUDIT_ENABLED !== 'true' || env.F1QL_SEMANTIC_CATALOG_AUDIT_TARGET !== 'production') {
    throw new Error('semantic catalog production audit is not enabled');
  }
  const connectionString = required(env, 'F1QL_ANSWER_DATABASE_URL');
  const hostname = new URL(connectionString).hostname.toLowerCase();
  if (isLoopbackHostname(hostname)) {
    throw new Error('semantic catalog production audit refuses local targets');
  }
  const context = {
    commit_sha: required(env, 'RAILWAY_GIT_COMMIT_SHA'),
    deployment_id: required(env, 'F1QL_ANSWER_DEPLOYMENT_ID'),
    release_id: required(env, 'F1QL_ANSWER_RELEASE_ID'),
    key_id: required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_KEY_ID'),
    private_key: loadPrivateKey(required(env, 'F1QL_ANSWER_PRODUCTION_EVIDENCE_PRIVATE_KEY_BASE64'))
  };
  if (!COMMIT_SHA.test(context.commit_sha) || !IDENTIFIER.test(context.deployment_id) || !IDENTIFIER.test(context.release_id) || !IDENTIFIER.test(context.key_id)) {
    throw new Error('semantic catalog production audit context is invalid');
  }
  const pool = new Pool({
    ...buildAnswerDatabasePoolConfig(connectionString, required(env, 'F1QL_ANSWER_DATABASE_CA_CERT_BASE64')),
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  try {
    const artifact = await auditSemanticCatalogBinding(pool, context);
    const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8');
    writeExclusive(output, bytes);
    return { output, status: 'pass', sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await pool.end();
  }
}

function loadPrivateKey(value: string): KeyObject {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value || decoded.byteLength < 32 || decoded.byteLength > 4_096) throw new Error('invalid');
    const key = createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
    return key;
  } catch {
    throw new Error('semantic catalog production audit signing key is invalid');
  }
}

function decodeCanonicalSignature(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 64 || decoded.toString('base64') !== value) {
    throw new Error('semantic catalog binding artifact signature is invalid');
  }
  return decoded;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 100_000) throw new Error(`missing ${name}`);
  return value;
}

function writeExclusive(path: string, content: Buffer): void {
  if (!path || path.length > 4_096 || path.includes('\0')) throw new Error('semantic catalog audit output path is invalid');
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const [output] = process.argv.slice(2);
  if (!output || process.argv.slice(2).length !== 1) throw new Error('semantic catalog audit arguments are invalid');
  const result = await writeSemanticCatalogBindingAudit(output);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  });
}
