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
  SemanticQueryCandidateSet
} from '../src/f1ql/semantic-query';
import reviewedSnapshotInput from '../tests/fixtures/compositional-regression.snapshot.json';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';

const PROBE_CASE_INDEX = 0;
const PROBE_CORPUS_SHA256 = 'f59dc627baa827826372ebe34e28fb9fd444169cb865e869ebc437c6f9abd2b7';
const PROBE_CORPUS_INPUT_SHA256 = '7083ba86e5c13cb9031449ea401b1220689702eba1a3305a99f1c53bf5afbbb5';
const PROBE_SNAPSHOT_INPUT_SHA256 = '9b2931e2f91a37e89aac41d099a6be66b8aa8f38f4502b044f9230169a5d4c3e';
const PROBE_CASE_ID = 'promoted-single-source-rows';
const PROBE_QUESTION_SHA256 = '9f14e18e0da9cec009af8f7c7ed325d3d59ed27122f709058e109a60a45aa11c';
const PROBE_CANDIDATE_SET_SHA256 = 'cd751e1664dcb10ed60a6bd4c042a230857c57925c3ca63d5e22ae2f9c5935bc';
const PROBE_PROVIDER_IDENTITY = Object.freeze({
  provider: 'openai-compatible',
  endpoint_sha256: 'bfbe26f9a530c9f1790ba4e42a7f34d93faf36026a3a32ca0c29a10b9f8e9fce',
  model_sha256: 'b22b20cb72f9142c9421d39583807b09bb1ab873708a80eb4d5cf7995f76f51a',
  catalog_projection_sha256: '8443b0250dec2e1a08d926a0e90aac98cdae1b247f7abebcc1accd0d8ce11a0b',
  prompt_sha256: '58c08cc0a126a9a6eca59bbafb3e35c7ea2f407738ba4f917293c386936b6d29',
  schema_sha256: '013596a11660433746a889f2c692b3d25e324786f1d3817e475c9d3aa82a8ffa',
  request_config_sha256: 'a3c3f1e5ac7359e9b0792949181721f074081f117de79cbd109185ed3d363277'
} as const);

type ProbeFailureReason =
  | 'guard_refused'
  | 'reviewed_fixture_invalid'
  | 'provider_not_configured'
  | 'provider_unavailable'
  | 'empty_candidate_set'
  | 'invalid_candidate_set'
  | 'oracle_mismatch'
  | 'unexpected_failure';

export type SemanticCandidateProviderProbeResult = {
  readonly status: 'passed';
  readonly case_id: string;
  readonly provider: 'openai-compatible';
  readonly candidate_count: number;
  readonly oracle_match: true;
} | {
  readonly status: 'failed';
  readonly reason: ProbeFailureReason;
  readonly case_id?: string;
  readonly provider?: 'openai-compatible';
  readonly diagnostic_code?: SemanticCandidateProposalError['code'];
};

interface ProbeDependencies {
  readonly proposer?: Pick<SemanticCandidateProposalAdapter, 'propose'>;
  readonly corpusInput?: unknown;
  readonly snapshotInput?: unknown;
}

interface ReviewedProbeCase {
  readonly caseId: string;
  readonly question: string;
}

interface ConfiguredProbe {
  readonly provider: 'openai-compatible';
  readonly proposer: Pick<SemanticCandidateProposalAdapter, 'propose'>;
}

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
    return { status: 'failed', reason: 'oracle_mismatch', case_id: reviewed.caseId, provider };
  }
  return {
    status: 'passed', case_id: reviewed.caseId, provider,
    candidate_count: actual.candidates.length, oracle_match: true
  };
}

function readConfiguredProbe(
  environment: NodeJS.ProcessEnv,
  injected: Pick<SemanticCandidateProposalAdapter, 'propose'> | undefined
): ConfiguredProbe | undefined {
  try {
    const identity = getConfiguredSemanticCandidateModelIdentity(environment);
    if (!matchesProbeProviderIdentity(identity)) {return undefined;}
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
    if (!matchesPinnedEvidence(evidence)) {
      return undefined;
    }
    return {
      caseId: item.id,
      question: item.question
    };
  } catch {
    return undefined;
  }
}

function matchesPinnedFixtureInputs(corpusInput: unknown, snapshotInput: unknown): boolean {
  if (!isCanonicalJson(corpusInput) || !isCanonicalJson(snapshotInput)) {return false;}
  if (!isRecord(corpusInput) || !isRecord(snapshotInput)) {return false;}
  return sha256(stableSerialize(corpusInput)) === PROBE_CORPUS_INPUT_SHA256 &&
    sha256(stableSerialize(snapshotInput)) === PROBE_SNAPSHOT_INPUT_SHA256 &&
    Array.isArray(corpusInput.cases) && corpusInput.cases.length === 19 &&
    snapshotInput.corpus_hash === PROBE_CORPUS_SHA256 &&
    Array.isArray(snapshotInput.cases) && snapshotInput.cases.length === 19;
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
