import { createHash } from 'node:crypto';
import {
  createSemanticCandidateModel,
  getConfiguredSemanticCandidateModelIdentity,
  SemanticCandidateProposalAdapter,
  SemanticCandidateProposalError
} from '../src/f1ql/semantic-candidate-translator';
import { SEMANTIC_CATALOG_HASH } from '../src/f1ql/semantic-catalog';
import {
  computeSemanticCandidateSetHash,
  enumerateSemanticQueries,
  parseSemanticQueryCandidateSet,
  SemanticQuery,
  SemanticQueryCandidateSet
} from '../src/f1ql/semantic-query';
import reviewedSnapshotInput from '../tests/fixtures/compositional-regression.snapshot.json';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';

const PROBE_CASE_INDEX = 0;
const PROBE_CORPUS_SHA256 = '36e77faf477aa08bec0f2e98881ee158ed28588acc18cf8c520db465089f0333';
const PROBE_CORPUS_INPUT_SHA256 = 'bb34e3a883f0a1368ca230d7940c509387d51b54ff1a4ed296660f1e843246d5';
const PROBE_SNAPSHOT_INPUT_SHA256 = 'e9dc25736e5c4496135ab57d9057236622276cf1b12d170c4347c0c6b770d002';
const PROBE_CASE_ID = 'promoted-single-source-rows';
const PROBE_QUESTION_SHA256 = '9f14e18e0da9cec009af8f7c7ed325d3d59ed27122f709058e109a60a45aa11c';
const PROBE_CANDIDATE_SET_SHA256 = 'cd751e1664dcb10ed60a6bd4c042a230857c57925c3ca63d5e22ae2f9c5935bc';
const PROBE_PROVIDER_IDENTITY = Object.freeze({
  provider: 'openai-compatible',
  endpoint_sha256: 'bfbe26f9a530c9f1790ba4e42a7f34d93faf36026a3a32ca0c29a10b9f8e9fce',
  model_sha256: 'b22b20cb72f9142c9421d39583807b09bb1ab873708a80eb4d5cf7995f76f51a',
  catalog_projection_sha256: '8443b0250dec2e1a08d926a0e90aac98cdae1b247f7abebcc1accd0d8ce11a0b',
  prompt_sha256: '3dc64b30facd1559a7cd0351a6817230641887e99ac90d523ff0b0042b81422c',
  schema_sha256: '013596a11660433746a889f2c692b3d25e324786f1d3817e475c9d3aa82a8ffa',
  request_config_sha256: 'a3c3f1e5ac7359e9b0792949181721f074081f117de79cbd109185ed3d363277'
} as const);
const PROBE_PROVIDER_IDENTITY_STATUS = 'retired' as const;

type ProbeFailureReason =
  | 'guard_refused'
  | 'reviewed_fixture_invalid'
  | 'provider_not_configured'
  | 'provider_identity_retired'
  | 'provider_unavailable'
  | 'empty_candidate_set'
  | 'invalid_candidate_set'
  | 'oracle_mismatch'
  | 'unexpected_failure';

type ProbeOracleMismatchCode = 'candidate_count' | 'evidence_spans' | 'semantic_structure';
type ProbeEvidenceMismatchCode = 'outputs' | 'scopes' | 'filters' | 'group_by' | 'comparison' | 'order_by' | 'limit' | 'mixed';

export type SemanticCandidateProviderProbeResult = {
  readonly status: 'passed';
  readonly case_id: string;
  readonly provider: 'openai-compatible';
  readonly candidate_count: number;
  readonly oracle_match: true;
  readonly evidence_code?: never;
} | {
  readonly status: 'failed';
  readonly reason: 'oracle_mismatch';
  readonly case_id: string;
  readonly provider: 'openai-compatible';
  readonly mismatch_code: 'evidence_spans';
  readonly evidence_code: ProbeEvidenceMismatchCode;
  readonly diagnostic_code?: never;
} | {
  readonly status: 'failed';
  readonly reason: 'oracle_mismatch';
  readonly case_id: string;
  readonly provider: 'openai-compatible';
  readonly mismatch_code: Exclude<ProbeOracleMismatchCode, 'evidence_spans'>;
  readonly evidence_code?: never;
  readonly diagnostic_code?: never;
} | {
  readonly status: 'failed';
  readonly reason: Exclude<ProbeFailureReason, 'oracle_mismatch'>;
  readonly case_id?: string;
  readonly provider?: 'openai-compatible';
  readonly diagnostic_code?: SemanticCandidateProposalError['code'];
  readonly mismatch_code?: never;
  readonly evidence_code?: never;
};

interface ProbeDependencies {
  readonly proposer?: Pick<SemanticCandidateProposalAdapter, 'propose'>;
  readonly corpusInput?: unknown;
  readonly snapshotInput?: unknown;
}

interface ReviewedProbeCase {
  readonly caseId: string;
  readonly question: string;
  readonly candidates: readonly SemanticQuery[];
}

interface ConfiguredProbe {
  readonly provider: 'openai-compatible';
  readonly proposer: Pick<SemanticCandidateProposalAdapter, 'propose'>;
}

type ProbeConfiguration = ConfiguredProbe | typeof PROBE_PROVIDER_IDENTITY_STATUS;

export async function probeSemanticCandidateProvider(
  environment: NodeJS.ProcessEnv,
  dependencies: ProbeDependencies = {}
): Promise<SemanticCandidateProviderProbeResult> {
  if (environment.F1QL_SEMANTIC_CANDIDATE_PROBE_ENABLED !== 'true' ||
      environment.F1QL_SEMANTIC_CANDIDATE_PROBE_TARGET !== 'non-production') {
    return { status: 'failed', reason: 'guard_refused' };
  }

  const reviewed = readReviewedProbeCase(
    dependencies.corpusInput ?? compositionalRegressionCorpusInput,
    dependencies.snapshotInput ?? reviewedSnapshotInput
  );
  if (!reviewed) {
    return { status: 'failed', reason: 'reviewed_fixture_invalid' };
  }
  const configured = readConfiguredProbe(environment, dependencies.proposer);
  if (!configured) {
    return { status: 'failed', reason: 'provider_not_configured', case_id: reviewed.caseId };
  }
  if (configured === 'retired') {
    return { status: 'failed', reason: 'provider_identity_retired', case_id: reviewed.caseId };
  }
  return executeProbe(configured, reviewed);
}

async function executeProbe(
  configured: ConfiguredProbe,
  reviewed: ReviewedProbeCase
): Promise<SemanticCandidateProviderProbeResult> {
  const { provider, proposer } = configured;
  let actualInput: SemanticQueryCandidateSet;
  try {
    actualInput = await proposer.propose({
      question: reviewed.question,
      semantic_query_version: 2,
      max_candidates: 5
    });
  } catch (error) {
    return error instanceof SemanticCandidateProposalError
      ? {
          status: 'failed', reason: 'provider_unavailable', case_id: reviewed.caseId,
          provider, diagnostic_code: error.code
        }
      : { status: 'failed', reason: 'unexpected_failure', case_id: reviewed.caseId, provider };
  }

  if (!actualInput || !Array.isArray(actualInput.candidates)) {
    return { status: 'failed', reason: 'invalid_candidate_set', case_id: reviewed.caseId, provider };
  }
  if (actualInput.candidates.length === 0) {
    return { status: 'failed', reason: 'empty_candidate_set', case_id: reviewed.caseId, provider };
  }
  let actual: SemanticQueryCandidateSet;
  try {
    actual = parseSemanticQueryCandidateSet(actualInput, reviewed.question);
  } catch {
    return { status: 'failed', reason: 'invalid_candidate_set', case_id: reviewed.caseId, provider };
  }
  if (computeSemanticCandidateSetHash(actual.candidates, PROBE_QUESTION_SHA256, SEMANTIC_CATALOG_HASH) !==
      PROBE_CANDIDATE_SET_SHA256) {
    return {
      status: 'failed', reason: 'oracle_mismatch', case_id: reviewed.caseId, provider,
      ...classifyOracleMismatch(reviewed.candidates, actual.candidates)
    };
  }
  return {
    status: 'passed', case_id: reviewed.caseId, provider,
    candidate_count: actual.candidates.length, oracle_match: true
  };
}

function readConfiguredProbe(
  environment: NodeJS.ProcessEnv,
  injected: Pick<SemanticCandidateProposalAdapter, 'propose'> | undefined
): ProbeConfiguration | undefined {
  try {
    const identity = getConfiguredSemanticCandidateModelIdentity(environment);
    if (!matchesProbeProviderIdentity(identity)) {return undefined;}
    if (PROBE_PROVIDER_IDENTITY_STATUS === 'retired') {return PROBE_PROVIDER_IDENTITY_STATUS;}
    return {
      provider: identity.provider,
      proposer: injected ?? new SemanticCandidateProposalAdapter(createSemanticCandidateModel(environment))
    };
  } catch {
    return undefined;
  }
}

function readReviewedProbeCase(
  corpusInput: unknown,
  snapshotInput: unknown
): ReviewedProbeCase | undefined {
  try {
    if (!matchesPinnedFixtureInputs(corpusInput, snapshotInput) ||
        !isRecord(corpusInput) || !Array.isArray(corpusInput.cases) ||
        !isRecord(snapshotInput) || !Array.isArray(snapshotInput.cases)) {
      return undefined;
    }
    const item = corpusInput.cases[PROBE_CASE_INDEX];
    const recorded = snapshotInput.cases[PROBE_CASE_INDEX];
    if (!matchesPinnedCorpusCase(item) || !matchesPinnedSnapshotCase(recorded)) {
      return undefined;
    }
    const evidence = enumerateSemanticQueries(item.question, []);
    if (evidence.type !== 'candidate_set' || !matchesPinnedEvidence(evidence)) {
      return undefined;
    }
    return {
      caseId: item.id,
      question: item.question,
      candidates: evidence.candidates
    };
  } catch {
    return undefined;
  }
}

function classifyOracleMismatch(
  expected: readonly SemanticQuery[],
  actual: readonly SemanticQuery[]
): { readonly mismatch_code: Exclude<ProbeOracleMismatchCode, 'evidence_spans'> } |
  { readonly mismatch_code: 'evidence_spans'; readonly evidence_code: ProbeEvidenceMismatchCode } {
  if (expected.length !== actual.length) {return { mismatch_code: 'candidate_count' };}
  const expectedStructure = expected.map(candidate => stableSerialize(withoutEvidence(candidate))).sort(compareText);
  const actualStructure = actual.map(candidate => stableSerialize(withoutEvidence(candidate))).sort(compareText);
  return stableSerialize(expectedStructure) === stableSerialize(actualStructure)
    ? { mismatch_code: 'evidence_spans', evidence_code: classifyEvidenceMismatch(expected, actual) }
    : { mismatch_code: 'semantic_structure' };
}

const EVIDENCE_FIELDS = ['outputs', 'scopes', 'filters', 'group_by', 'comparison', 'order_by', 'limit'] as const;

function classifyEvidenceMismatch(
  expected: readonly SemanticQuery[],
  actual: readonly SemanticQuery[]
): ProbeEvidenceMismatchCode {
  const differing = EVIDENCE_FIELDS.filter(field =>
    evidenceFieldFingerprint(expected, field) !== evidenceFieldFingerprint(actual, field));
  return differing.length === 1 ? differing[0] : 'mixed';
}

function evidenceFieldFingerprint(
  candidates: readonly SemanticQuery[],
  field: typeof EVIDENCE_FIELDS[number]
): string {
  return stableSerialize(candidates.map(candidate => stableSerialize({
    structure: withoutEvidence(candidate),
    field: canonicalEvidenceField(candidate[field] ?? null, field)
  })).sort(compareText));
}

function canonicalEvidenceField(value: unknown, field: typeof EVIDENCE_FIELDS[number]): unknown {
  if (Array.isArray(value) && ['scopes', 'filters', 'group_by'].includes(field)) {
    return [...value].sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)));
  }
  return value;
}

function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(child => withoutEvidence(child));}
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'evidence')
      .map(([key, child]) => {
        const stripped = withoutEvidence(child);
        return [key, ['scopes', 'filters', 'group_by'].includes(key) && Array.isArray(stripped)
          ? stripped.sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)))
          : stripped];
      }));
  }
  return value;
}

function matchesPinnedFixtureInputs(corpusInput: unknown, snapshotInput: unknown): boolean {
  if (!isCanonicalJson(corpusInput) || !isCanonicalJson(snapshotInput)) {return false;}
  if (!isRecord(corpusInput) || !isRecord(snapshotInput)) {return false;}
  return sha256(stableSerialize(corpusInput)) === PROBE_CORPUS_INPUT_SHA256 &&
    sha256(stableSerialize(snapshotInput)) === PROBE_SNAPSHOT_INPUT_SHA256 &&
    Array.isArray(corpusInput.cases) && corpusInput.cases.length === 22 &&
    snapshotInput.corpus_hash === PROBE_CORPUS_SHA256 &&
    Array.isArray(snapshotInput.cases) && snapshotInput.cases.length === 22;
}

function matchesPinnedCorpusCase(
  input: unknown
): input is Record<string, unknown> & { id: typeof PROBE_CASE_ID; question: string } {
  return isRecord(input) && input.id === PROBE_CASE_ID && typeof input.question === 'string' &&
    sha256(input.question) === PROBE_QUESTION_SHA256 && Array.isArray(input.entities) &&
    input.entities.length === 0 && input.provider_mode === 'enumerated';
}

function matchesPinnedSnapshotCase(input: unknown): boolean {
  if (!isRecord(input) || !isRecord(input.evidence)) {return false;}
  return input.id === PROBE_CASE_ID && input.question_sha256 === PROBE_QUESTION_SHA256 &&
    input.evidence.type === 'candidate_set' && input.evidence.candidate_count === 1 &&
    input.evidence.candidate_set_hash === PROBE_CANDIDATE_SET_SHA256;
}

function matchesPinnedEvidence(input: ReturnType<typeof enumerateSemanticQueries>): boolean {
  return input.type === 'candidate_set' && input.candidates.length === 1 &&
    input.question_sha256 === PROBE_QUESTION_SHA256 && input.catalog_hash === SEMANTIC_CATALOG_HASH &&
    input.candidate_set_hash === PROBE_CANDIDATE_SET_SHA256;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isCanonicalJson(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {return true;}
  if (typeof value === 'number') {return Number.isFinite(value) && !Object.is(value, -0);}
  if (!value || typeof value !== 'object' || ancestors.has(value)) {return false;}
  return Array.isArray(value)
    ? isCanonicalJsonArray(value, ancestors)
    : isCanonicalJsonObject(value, ancestors);
}

function isCanonicalJsonArray(value: unknown[], ancestors: WeakSet<object>): boolean {
  const keys = Object.keys(value);
  const ownKeys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index)) ||
      ownKeys.length !== keys.length + 1 || ownKeys.some((key, index) =>
        index < keys.length ? key !== keys[index] : key !== 'length') ||
      !lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== value.length) {
    return false;
  }
  return hasCanonicalJsonChildren(value, keys, ancestors);
}

function isCanonicalJsonObject(value: object, ancestors: WeakSet<object>): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) {return false;}
  const keys = Reflect.ownKeys(value);
  if (keys.length !== Object.keys(value).length || keys.some(key => typeof key !== 'string')) {return false;}
  return hasCanonicalJsonChildren(value, keys as string[], ancestors);
}

function hasCanonicalJsonChildren(
  value: object,
  keys: readonly string[],
  ancestors: WeakSet<object>
): boolean {
  ancestors.add(value);
  const valid = keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor &&
      isCanonicalJson(descriptor.value, ancestors);
  });
  ancestors.delete(value);
  return valid;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function matchesProbeProviderIdentity(
  identity: ReturnType<typeof getConfiguredSemanticCandidateModelIdentity>
): identity is typeof PROBE_PROVIDER_IDENTITY {
  return Object.entries(PROBE_PROVIDER_IDENTITY).every(
    ([key, value]) => identity[key as keyof typeof identity] === value
  );
}

if (require.main === module) {
  void probeSemanticCandidateProvider(process.env).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'passed') {process.exitCode = 1;}
  }).catch(() => {
    process.stdout.write('{"status":"failed","reason":"unexpected_failure"}\n');
    process.exitCode = 1;
  });
}
