import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAnswerQuestionContract } from './answer-question';
import {
  ConfiguredSemanticCandidateModelIdentity,
  getConfiguredSemanticCandidateModelIdentityForOutputContract,
  SemanticCandidateModel,
  SemanticCandidateProposalError,
  SemanticCandidateStructuredOutputContract
} from './semantic-candidate-translator';
import {
  SEMANTIC_QUERY_MAX_CANDIDATES,
  SEMANTIC_QUERY_VERSION,
  SemanticQuery,
  SemanticQueryCandidateSet,
  computeSemanticCandidateSetHash,
  computeSemanticQueryHash,
  parseSemanticQueryCandidateSet
} from './semantic-query';

export const SEMANTIC_CANDIDATE_SELECTION_VERSION = 2 as const;
export const SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME = 'f1_semantic_candidate_selection_v2';
export const SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS = 128;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export const SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT =
  'Select the supplied canonical semantic candidate that best answers the normalized question. ' +
  'The server independently constructed every candidate and its opaque candidate_id. ' +
  'Return exactly one supplied candidate_id using the strict response schema. ' +
  'Do not reconstruct, edit, merge, omit, or invent candidates. Return no prose, markdown, SQL, F1QL, Core, or database values.';

export const SEMANTIC_CANDIDATE_SELECTION_SCHEMA_TEMPLATE = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'candidate_id'],
  properties: {
    version: { type: 'integer', enum: [SEMANTIC_CANDIDATE_SELECTION_VERSION] },
    candidate_id: { type: 'string', enum: ['<server-enumerated-candidate-id>'] }
  }
});

export const SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256 = hash(stableSerialize(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_TEMPLATE));
export const SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256 = hash(SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT);
export const SEMANTIC_CANDIDATE_SELECTION_PROJECTION = deepFreeze({
  version: SEMANTIC_CANDIDATE_SELECTION_VERSION,
  request_fields: ['question', 'semantic_query_version', 'candidate_set_hash', 'catalog_hash', 'candidates'],
  candidate_fields: ['candidate_id', 'semantic_query'],
  authority: 'server_enumerated_canonical_candidates'
});
export const SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256 = hash(stableSerialize(SEMANTIC_CANDIDATE_SELECTION_PROJECTION));

export interface SemanticCandidateSelectionRequest {
  readonly question: string;
  readonly semantic_query_version: typeof SEMANTIC_QUERY_VERSION;
  readonly candidate_set_hash: string;
  readonly catalog_hash: string;
  readonly candidates: readonly SemanticQuery[];
}

export interface SemanticCandidateSelectionProviderRequest {
  readonly version: typeof SEMANTIC_CANDIDATE_SELECTION_VERSION;
  readonly question: string;
  readonly semantic_query_version: typeof SEMANTIC_QUERY_VERSION;
  readonly candidate_set_hash: string;
  readonly candidates: readonly {
    readonly candidate_id: string;
    readonly semantic_query: SemanticQuery;
  }[];
}

export class SemanticCandidateSelectionAdapter {
  constructor(private readonly model: SemanticCandidateModel) {}

  async propose(
    request: SemanticCandidateSelectionRequest,
    signal?: AbortSignal
  ): Promise<SemanticQueryCandidateSet> {
    let providerRequest: SemanticCandidateSelectionProviderRequest;
    let canonicalCandidates: SemanticQueryCandidateSet;
    try {
      const question = createAnswerQuestionContract(request.question);
      if (request.semantic_query_version !== SEMANTIC_QUERY_VERSION ||
          !HASH_PATTERN.test(request.catalog_hash) || !HASH_PATTERN.test(request.candidate_set_hash)) {
        throw new Error('unsupported semantic candidate selection contract');
      }
      canonicalCandidates = parseSemanticQueryCandidateSet({
        version: SEMANTIC_QUERY_VERSION,
        candidates: request.candidates
      }, question.normalized_question);
      const candidateSetHash = computeSemanticCandidateSetHash(
        canonicalCandidates.candidates,
        question.sha256,
        request.catalog_hash
      );
      if (candidateSetHash !== request.candidate_set_hash) {
        throw new Error('semantic candidate selection set is not evidence-bound');
      }
      providerRequest = buildProviderRequest(question.normalized_question, request, canonicalCandidates.candidates);
    } catch {
      throw new SemanticCandidateProposalError('schema_invalid');
    }

    const candidateIds = providerRequest.candidates.map(candidate => candidate.candidate_id);
    let raw: string;
    try {
      raw = await this.model.complete(
        SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT,
        providerRequest,
        signal,
        buildSelectionOutputContract(candidateIds)
      );
    } catch (error) {
      if (error instanceof SemanticCandidateProposalError) {throw error;}
      throw new SemanticCandidateProposalError(signal?.aborted ? 'cancelled' : 'transport');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SemanticCandidateProposalError('malformed');
    }
    try {
      const selected = selectionResponseSchema(candidateIds).parse(parsed);
      const index = candidateIds.indexOf(selected.candidate_id);
      if (index < 0) {throw new Error('selected candidate is outside the enumerated set');}
      return parseSemanticQueryCandidateSet({
        version: SEMANTIC_QUERY_VERSION,
        candidates: [canonicalCandidates.candidates[index]]
      }, providerRequest.question);
    } catch {
      throw new SemanticCandidateProposalError('schema_invalid');
    }
  }
}

export function buildSemanticCandidateSelectionRequest(
  questionInput: unknown,
  evidence: {
    readonly catalog_hash: string;
    readonly candidate_set_hash: string;
    readonly candidates: readonly SemanticQuery[];
  }
): SemanticCandidateSelectionRequest {
  const question = createAnswerQuestionContract(questionInput);
  return Object.freeze({
    question: question.normalized_question,
    semantic_query_version: SEMANTIC_QUERY_VERSION,
    candidate_set_hash: evidence.candidate_set_hash,
    catalog_hash: evidence.catalog_hash,
    candidates: evidence.candidates
  });
}

export function getConfiguredSemanticCandidateSelectionIdentity(
  env: NodeJS.ProcessEnv = process.env
): ConfiguredSemanticCandidateModelIdentity {
  return getConfiguredSemanticCandidateModelIdentityForOutputContract({
    catalog_projection_sha256: SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256,
    prompt_sha256: SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
    schema_sha256: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256,
    schema_name: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
    max_tokens: SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS
  }, env);
}

function buildProviderRequest(
  question: string,
  request: SemanticCandidateSelectionRequest,
  candidates: readonly SemanticQuery[]
): SemanticCandidateSelectionProviderRequest {
  return deepFreeze({
    version: SEMANTIC_CANDIDATE_SELECTION_VERSION,
    question,
    semantic_query_version: SEMANTIC_QUERY_VERSION,
    candidate_set_hash: request.candidate_set_hash,
    candidates: candidates.map(candidate => ({
      candidate_id: computeSemanticQueryHash(candidate),
      semantic_query: candidate
    }))
  });
}

function buildSelectionOutputContract(
  candidateIds: readonly string[]
): SemanticCandidateStructuredOutputContract {
  if (candidateIds.length < 1 || candidateIds.length > SEMANTIC_QUERY_MAX_CANDIDATES ||
      new Set(candidateIds).size !== candidateIds.length || candidateIds.some(id => !HASH_PATTERN.test(id))) {
    throw new SemanticCandidateProposalError('schema_invalid');
  }
  const schema = deepFreeze({
    type: 'object',
    additionalProperties: false,
    required: ['version', 'candidate_id'],
    properties: {
      version: { type: 'integer', enum: [SEMANTIC_CANDIDATE_SELECTION_VERSION] },
      candidate_id: { type: 'string', enum: [...candidateIds] }
    }
  });
  return Object.freeze({
    schema_name: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
    openai_schema: schema,
    anthropic_schema: schema,
    max_tokens: SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS
  });
}

function selectionResponseSchema(candidateIds: readonly string[]) {
  return z.object({
    version: z.literal(SEMANTIC_CANDIDATE_SELECTION_VERSION),
    candidate_id: z.string().refine(value => candidateIds.includes(value), 'candidate_id is not enumerated')
  }).strict();
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
  }
  return value;
}
