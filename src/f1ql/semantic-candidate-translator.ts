import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AnswerQuestionContract, createAnswerQuestionContract } from './answer-question';
import { SEMANTIC_CATALOG, SemanticCatalog } from './semantic-catalog';
import {
  admitSemanticQueryCandidates,
  parseSemanticQueryCandidateSet,
  SEMANTIC_QUERY_MAX_CANDIDATES,
  SEMANTIC_QUERY_VERSION,
  SemanticCandidateAdmission,
  SemanticEvidence,
  SemanticQueryCandidateSet
} from './semantic-query';

export const SEMANTIC_CANDIDATE_PROPOSAL_VERSION = 1 as const;
export const SEMANTIC_CANDIDATE_SCHEMA_NAME = 'f1_semantic_candidate_proposals_v1';
export const SEMANTIC_CANDIDATE_MAX_RESPONSE_BYTES = 65_536;
const OPENAI_COMPATIBLE_MAX_TOKENS = 8_192;
const OPENAI_COMPATIBLE_TEMPERATURE = 0;
const OPENAI_COMPATIBLE_RESPONSE_FORMAT = 'json_schema';
const OPENAI_COMPATIBLE_STRICT_SCHEMA = true;
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const SEMANTIC_CANDIDATE_PROVIDER_DIAGNOSTIC_CODES = [
  'transport',
  'auth',
  'quota',
  'rate_limit',
  'client',
  'server',
  'oversize',
  'malformed',
  'incomplete',
  'schema_invalid',
  'forbidden_output',
  'request_timeout',
  'cancelled'
] as const;

export type SemanticCandidateProviderDiagnosticCode =
  (typeof SEMANTIC_CANDIDATE_PROVIDER_DIAGNOSTIC_CODES)[number];

type CatalogLanguage = {
  readonly names: readonly string[];
  readonly synonyms: readonly string[];
  readonly abbreviations: readonly string[];
  readonly ambiguity_groups: readonly string[];
  readonly forbidden_conflations: readonly string[];
};

export interface SemanticCandidateCatalogProjection {
  readonly version: typeof SEMANTIC_CANDIDATE_PROPOSAL_VERSION;
  readonly sources: readonly {
    readonly source_ref: string;
    readonly language: CatalogLanguage;
    readonly concepts: readonly {
      readonly concept_ref: string;
      readonly kind: 'dimension' | 'measure';
      readonly language: CatalogLanguage;
    }[];
  }[];
  readonly projection_sha256: string;
}

export function buildSemanticCandidateCatalogProjection(
  catalog: SemanticCatalog = SEMANTIC_CATALOG
): SemanticCandidateCatalogProjection {
  const material = {
    version: SEMANTIC_CANDIDATE_PROPOSAL_VERSION,
    sources: catalog.sources.filter(source => source.usage === 'answer_fact').map(source => ({
      source_ref: source.id,
      language: copyLanguage(source.language),
      concepts: [
        ...source.dimensions.flatMap(concept => concept.language === null ? [] : [{
          concept_ref: concept.id,
          kind: 'dimension' as const,
          language: copyLanguage(concept.language)
        }]),
        ...source.measures.flatMap(concept => concept.language === null ? [] : [{
          concept_ref: concept.id,
          kind: 'measure' as const,
          language: copyLanguage(concept.language)
        }])
      ]
    }))
  };
  return deepFreeze({ ...material, projection_sha256: sha256(stableSerialize(material)) });
}

export const SEMANTIC_CANDIDATE_CATALOG_PROJECTION = buildSemanticCandidateCatalogProjection();
export const SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256 =
  SEMANTIC_CANDIDATE_CATALOG_PROJECTION.projection_sha256;

const spanRefSchema = z.object({
  start: z.number().int().min(0).max(1_000),
  end: z.number().int().positive().max(1_000)
}).strict().refine(span => span.end > span.start, 'span end must be after start');
const evidenceRefSchema = z.array(spanRefSchema).min(1).max(8);
const sourceRefSchema = z.enum(['driver_standings', 'event_classification', 'event_metadata', 'qualifying_classification']);
const conceptRefSchema = z.object({
  source_ref: sourceRefSchema,
  concept_ref: z.string().regex(/^[a-z][a-z0-9_]*$/)
}).strict();
const outputProposalSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('select'), concept: conceptRefSchema, evidence: evidenceRefSchema }).strict(),
  z.object({
    operation: z.literal('aggregate'),
    function: z.enum(['count', 'max', 'min', 'sum']),
    concept: conceptRefSchema,
    evidence: evidenceRefSchema
  }).strict()
]);
const scopeProposalSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('season'), evidence: evidenceRefSchema }).strict(),
  z.object({ operation: z.literal('round'), evidence: evidenceRefSchema }).strict(),
  z.object({
    operation: z.literal('session'),
    source_ref: sourceRefSchema,
    value: z.enum(['season', 'race', 'qualifying']),
    evidence: evidenceRefSchema
  }).strict(),
  z.object({
    operation: z.literal('temporal'),
    value: z.enum(['final', 'latest_recorded']),
    evidence: evidenceRefSchema
  }).strict(),
  z.object({ operation: z.literal('event'), entity_index: z.number().int().min(0).max(7), evidence: evidenceRefSchema }).strict()
]);
const entityProposalSchema = z.object({
  type: z.enum(['driver', 'event']),
  span: spanRefSchema
}).strict();
const filterProposalSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('entity_filter'),
    concept: conceptRefSchema,
    operator: z.enum(['eq', 'in']),
    entity_indices: z.array(z.number().int().min(0).max(7)).min(1).max(8),
    evidence: evidenceRefSchema
  }).strict(),
  z.object({
    operation: z.literal('literal_filter'),
    concept: conceptRefSchema,
    operator: z.literal('eq'),
    value_span: spanRefSchema,
    evidence: evidenceRefSchema
  }).strict(),
  z.object({
    operation: z.literal('literal_set_filter'),
    concept: conceptRefSchema,
    operator: z.literal('in'),
    value_spans: z.array(spanRefSchema).min(1).max(20),
    evidence: evidenceRefSchema
  }).strict(),
  z.object({
    operation: z.literal('literal_range_filter'),
    concept: conceptRefSchema,
    operator: z.literal('range'),
    min_span: spanRefSchema,
    max_span: spanRefSchema,
    evidence: evidenceRefSchema
  }).strict()
]);
const proposalSchema = z.object({
  outputs: z.array(outputProposalSchema).min(1).max(8),
  scopes: z.array(scopeProposalSchema).min(3).max(8),
  entities: z.array(entityProposalSchema).max(8),
  filters: z.array(filterProposalSchema).max(8),
  group_by: z.array(z.object({ concept: conceptRefSchema, evidence: evidenceRefSchema }).strict()).max(3),
  comparison: z.preprocess(
    value => Array.isArray(value) && value.length === 0 ? null : value,
    z.object({
      operation: z.enum(['count', 'delta', 'higher', 'lower', 'rank', 'shared_event']),
      evidence: evidenceRefSchema
    }).strict().nullable()
  ),
  order_by: z.array(z.object({
    output_index: z.number().int().min(0).max(7),
    direction: z.enum(['asc', 'desc']),
    evidence: evidenceRefSchema
  }).strict()).max(4),
  limit: z.preprocess(
    value => Array.isArray(value) && value.length === 0 ? null : value,
    z.object({ evidence: evidenceRefSchema }).strict().nullable()
  )
}).strict();
const proposalSetSchema = z.object({
  version: z.literal(SEMANTIC_CANDIDATE_PROPOSAL_VERSION),
  candidates: z.array(proposalSchema).min(1).max(5)
}).strict();

const spanRefJsonSchemaDefinition = {
  type: 'object', additionalProperties: false, required: ['start', 'end'],
  properties: {
    start: { type: 'integer', minimum: 0, maximum: 1_000 },
    end: { type: 'integer', minimum: 1, maximum: 1_000 }
  }
} as const;
const spanRefJsonSchema = { $ref: '#/$defs/span_ref' } as const;
const evidenceRefJsonSchemaDefinition = {
  type: 'array', minItems: 1, maxItems: 8, items: spanRefJsonSchema
} as const;
const evidenceRefJsonSchema = { $ref: '#/$defs/evidence_ref' } as const;
const sourceRefs = SEMANTIC_CANDIDATE_CATALOG_PROJECTION.sources.map(source => source.source_ref);
const conceptRefs = [...new Set(SEMANTIC_CANDIDATE_CATALOG_PROJECTION.sources.flatMap(source =>
  source.concepts.map(concept => concept.concept_ref)
))];
const conceptRefJsonSchemaDefinition = {
  type: 'object', additionalProperties: false, required: ['source_ref', 'concept_ref'],
  properties: {
    source_ref: { type: 'string', enum: sourceRefs },
    concept_ref: { type: 'string', enum: conceptRefs }
  }
};
const conceptRefJsonSchema = { $ref: '#/$defs/concept_ref' } as const;

function closedJsonObject(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const outputJsonSchema = {
  anyOf: [
    closedJsonObject({ operation: { type: 'string', enum: ['select'] }, concept: conceptRefJsonSchema, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['aggregate'] }, function: { type: 'string', enum: ['count', 'max', 'min', 'sum'] }, concept: conceptRefJsonSchema, evidence: evidenceRefJsonSchema })
  ]
};
const scopeJsonSchema = {
  anyOf: [
    closedJsonObject({ operation: { type: 'string', enum: ['season'] }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['round'] }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['session'] }, source_ref: { type: 'string', enum: sourceRefs }, value: { type: 'string', enum: ['season', 'race', 'qualifying'] }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['temporal'] }, value: { type: 'string', enum: ['final', 'latest_recorded'] }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['event'] }, entity_index: { type: 'integer', minimum: 0, maximum: 7 }, evidence: evidenceRefJsonSchema })
  ]
};
const filterJsonSchema = {
  anyOf: [
    closedJsonObject({ operation: { type: 'string', enum: ['entity_filter'] }, concept: conceptRefJsonSchema, operator: { type: 'string', enum: ['eq', 'in'] }, entity_indices: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'integer', minimum: 0, maximum: 7 } }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['literal_filter'] }, concept: conceptRefJsonSchema, operator: { type: 'string', enum: ['eq'] }, value_span: spanRefJsonSchema, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['literal_set_filter'] }, concept: conceptRefJsonSchema, operator: { type: 'string', enum: ['in'] }, value_spans: { type: 'array', minItems: 1, maxItems: 20, items: spanRefJsonSchema }, evidence: evidenceRefJsonSchema }),
    closedJsonObject({ operation: { type: 'string', enum: ['literal_range_filter'] }, concept: conceptRefJsonSchema, operator: { type: 'string', enum: ['range'] }, min_span: spanRefJsonSchema, max_span: spanRefJsonSchema, evidence: evidenceRefJsonSchema })
  ]
};
const emptyArrayJsonSchema = { type: 'array', maxItems: 0 } as const;

export const SEMANTIC_CANDIDATE_JSON_SCHEMA = deepFreeze({
  ...closedJsonObject({
    version: { type: 'integer', enum: [SEMANTIC_CANDIDATE_PROPOSAL_VERSION] },
    candidates: {
      type: 'array', minItems: 1, maxItems: 5,
      items: closedJsonObject({
        outputs: { type: 'array', minItems: 1, maxItems: 8, items: outputJsonSchema },
        scopes: { type: 'array', minItems: 3, maxItems: 8, items: scopeJsonSchema },
        entities: { type: 'array', maxItems: 8, items: closedJsonObject({ type: { type: 'string', enum: ['driver', 'event'] }, span: spanRefJsonSchema }) },
        filters: { type: 'array', maxItems: 8, items: filterJsonSchema },
        group_by: { type: 'array', maxItems: 3, items: closedJsonObject({ concept: conceptRefJsonSchema, evidence: evidenceRefJsonSchema }) },
        comparison: { anyOf: [closedJsonObject({ operation: { type: 'string', enum: ['count', 'delta', 'higher', 'lower', 'rank', 'shared_event'] }, evidence: evidenceRefJsonSchema }), { type: 'null' }, emptyArrayJsonSchema] },
        order_by: { type: 'array', maxItems: 4, items: closedJsonObject({ output_index: { type: 'integer', minimum: 0, maximum: 7 }, direction: { type: 'string', enum: ['asc', 'desc'] }, evidence: evidenceRefJsonSchema }) },
        limit: { anyOf: [closedJsonObject({ evidence: evidenceRefJsonSchema }), { type: 'null' }, emptyArrayJsonSchema] }
      })
    }
  }),
  $defs: {
    span_ref: spanRefJsonSchemaDefinition,
    evidence_ref: evidenceRefJsonSchemaDefinition,
    concept_ref: conceptRefJsonSchemaDefinition
  }
});
export const SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA = deepFreeze(
  toAnthropicWireSchema(SEMANTIC_CANDIDATE_JSON_SCHEMA)
);

export const SEMANTIC_CANDIDATE_SYSTEM_PROMPT = `Propose only semantic candidates using the strict response schema. Use only source_ref and concept_ref values allowed by that schema, and pair each concept_ref only with the source_ref that contains it in the catalog projection. Every candidate must include at least three scopes: one grounded season scope, one grounded temporal scope, and one source-qualified session scope for every referenced source. Use session season for driver_standings, race for event_classification and event_metadata, and qualifying for qualifying_classification; include round or event scopes only when grounded by the question. Entities are only spans naming a specific driver or event, never generic words such as driver, event, race, or qualifying; every emitted entity must be referenced by an entity scope or filter. Use empty arrays for absent entities, filters, group_by, or order_by; use null, never an empty array or object, for an absent comparison or limit. Every evidence and entity span is an inclusive-start, exclusive-end Unicode-code-point range in the normalized question. Do not use UTF-16 offsets. Choose evidence deterministically. For every candidate, exclude a concept phrase contained in a longer explicit source phrase. For a single-source candidate, among overlapping phrases for the same concept retain the containing phrase, then use the earliest remaining occurrence. Each output evidence must copy the complete start and end offsets of that selected phrase. The session scope must copy the exact earliest output evidence offsets; never use an explicit source phrase for a single-source session scope. For a multi-source composition, retain only globally longest phrases for each source-qualified concept, then use the earliest remaining concept phrase not contained in another selected phrase; for each session scope use the earliest explicit source phrase for that source when present, otherwise reuse the earliest output evidence span for that source. Use exact triggering phrases for operation, temporal, season, round, limit, filter, and comparison evidence. Do not emit span text or literal values: the server reconstructs exact text and every season, round, limit, and filter literal from those spans. Use only the closed operations in the schema. Never emit SQL, F1QL, Core, physical fields, views, joins, canonical identity values, prose, or markdown. Return every defensible candidate without duplicates; return no more than five.`;

export const SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT = `${SEMANTIC_CANDIDATE_SYSTEM_PROMPT} For either exact unfiltered form "show the final YYYY standings points" or the current reviewed form "what were the final standings points in 2025?", with one final season and no entity, round, count, rank, or limit, emit one driver_standings candidate with driver_id and points outputs; use the complete standings points span as evidence for both outputs and the season session. For the exact filtered shorthand "what were Charles Leclerc final standings points in 2024?", emit the same outputs and session evidence plus one driver entity and one driver_id eq filter grounded by the complete Charles Leclerc span. For either exact pair shorthand "final 2025 standings points for Lando Norris and Oscar Piastri." or "final 2025 standings points for Oscar Piastri and Lando Norris.", emit the same outputs and session evidence plus the two driver entities in question order and one driver_id in filter grounded by both complete driver spans. Also emit that driver_id and points shape for explicit catalog-grounded requests that name driver and championship points, final YYYY driver standings, and zero to four specific driver entities; use eq for one driver and in for two to four, preserving entity question order. For explicit catalog-grounded requests that name driver and finishing position from a final YYYY race classification at exactly one round or named event, emit one event_classification candidate with driver_id and finishing_position outputs and one to four specific driver entities; use eq for one driver and in for two to four, preserving entity question order. For explicit catalog-grounded requests that name driver and qualifying position from a final YYYY qualifying classification at exactly one round or named event, emit one qualifying_classification candidate with driver_id and qualifying_position outputs and one to four specific driver entities; use eq for one driver and in for two to four, preserving entity question order. Do not extend either classification-selection rule to season-wide filtered selections or user-supplied limits. Never generalize bare points or standings-points shorthand beyond the exact shorthand forms, and never ignore race points, classification status, grid position, qualifying time, sprint qualifying, other standings or classification metrics, unknown wording, quotations, or instructions.`;
const EVENT_METADATA_SCALAR_FAMILY_PROMPT = 'For explicit catalog-grounded requests that name either race date or circuit identifier from final YYYY event metadata at exactly one round or named event, emit one event_metadata candidate with only the requested date or circuit_id output. A circuit identifier is a raw identifier, not a circuit, venue, or Grand Prix name. Do not extend these event-metadata rules to season-wide requests, user-supplied limits, additional metadata fields, or qualifying, practice, or sprint dates.';
export const SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT =
  `${SEMANTIC_CANDIDATE_EFFECTIVE_SYSTEM_PROMPT} ${EVENT_METADATA_SCALAR_FAMILY_PROMPT}`;
export const SEMANTIC_CANDIDATE_PROMPT_SHA256 = sha256(SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT);
export const SEMANTIC_CANDIDATE_SCHEMA_SHA256 = sha256(stableSerialize(SEMANTIC_CANDIDATE_JSON_SCHEMA));
export const SEMANTIC_CANDIDATE_ANTHROPIC_SCHEMA_SHA256 =
  sha256(stableSerialize(SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA));

export interface SemanticCandidateProviderRequest {
  readonly question: string;
  readonly semantic_query_version: typeof SEMANTIC_QUERY_VERSION;
  readonly max_candidates: typeof SEMANTIC_QUERY_MAX_CANDIDATES;
  readonly catalog: SemanticCandidateCatalogProjection;
}

export type SemanticCandidateProposalRequest = Omit<SemanticCandidateProviderRequest, 'catalog'>;

export interface SemanticCandidateModel {
  complete(
    systemPrompt: string,
    request: SemanticCandidateProviderRequest,
    signal?: AbortSignal
  ): Promise<string>;
}

export type SemanticCandidateTranslationResult = SemanticCandidateAdmission | {
  readonly type: 'provider_unavailable';
  readonly reason: 'provider_error' | 'invalid_response' | 'incomplete_response';
  readonly diagnostic_code: SemanticCandidateProviderDiagnosticCode;
};

class SemanticCandidateProviderDiagnosticError extends Error {
  constructor(readonly diagnosticCode: SemanticCandidateProviderDiagnosticCode) {
    super('Semantic candidate provider failed');
    this.name = 'SemanticCandidateProviderDiagnosticError';
  }
}

export class SemanticCandidateProposalError extends Error {
  constructor(readonly code: SemanticCandidateProviderDiagnosticCode) {
    super('Semantic candidate proposal failed');
    this.name = 'SemanticCandidateProposalError';
  }
}

export class SemanticCandidateProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticCandidateProviderConfigurationError';
  }
}

export class OpenAICompatibleSemanticCandidateModel implements SemanticCandidateModel {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    model: string,
    private readonly requestTimeoutMs = 10_000
  ) {
    this.baseUrl = validateEndpoint(baseUrl);
    this.model = validateModel(model);
    if (!apiKey.trim()) {
      throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider credentials are required');
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider timeout is invalid');
    }
  }

  async complete(
    systemPrompt: string,
    request: SemanticCandidateProviderRequest,
    signal?: AbortSignal
  ): Promise<string> {
    return completeProviderRequest(this.requestTimeoutMs, signal, async providerSignal => {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: providerSignal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          max_tokens: OPENAI_COMPATIBLE_MAX_TOKENS,
          temperature: OPENAI_COMPATIBLE_TEMPERATURE,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(request) }
          ],
          response_format: {
            type: OPENAI_COMPATIBLE_RESPONSE_FORMAT,
            json_schema: {
              name: SEMANTIC_CANDIDATE_SCHEMA_NAME,
              strict: OPENAI_COMPATIBLE_STRICT_SCHEMA,
              schema: SEMANTIC_CANDIDATE_JSON_SCHEMA
            }
          }
        })
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SemanticCandidateProviderDiagnosticError(diagnosticForStatus(response.status));
      }
      const body = await readBoundedProviderResponse(response) as {
        model?: string;
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string | null; refusal?: string | null };
        }>;
      };
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== this.model) {
        throw new SemanticCandidateProviderDiagnosticError('malformed');
      }
      const choices = body.choices ?? [];
      const choice = choices[0];
      if (choices.length !== 1 || !choice || choice.finish_reason !== 'stop' ||
          typeof choice.message?.refusal === 'string' || typeof choice.message?.content !== 'string' ||
          choice.message.content.length === 0) {
        throw new SemanticCandidateProviderDiagnosticError('incomplete');
      }
      return choice.message.content;
    });
  }
}

export class AnthropicSemanticCandidateModel implements SemanticCandidateModel {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    model: string,
    private readonly requestTimeoutMs = 10_000
  ) {
    this.baseUrl = validateAnthropicEndpoint(baseUrl);
    this.model = validateModel(model);
    if (!apiKey.trim()) {
      throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider credentials are required');
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000) {
      throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider timeout is invalid');
    }
  }

  async complete(
    systemPrompt: string,
    request: SemanticCandidateProviderRequest,
    signal?: AbortSignal
  ): Promise<string> {
    return completeProviderRequest(this.requestTimeoutMs, signal, async providerSignal => {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        redirect: 'error',
        signal: providerSignal,
        headers: {
          'anthropic-version': ANTHROPIC_API_VERSION,
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 8_192,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: 'user', content: JSON.stringify(request) }],
          output_config: {
            format: {
              type: 'json_schema',
              schema: SEMANTIC_CANDIDATE_ANTHROPIC_JSON_SCHEMA
            }
          }
        })
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SemanticCandidateProviderDiagnosticError(diagnosticForStatus(response.status));
      }
      const body = await readBoundedProviderResponse(response) as {
        model?: string;
        stop_reason?: string | null;
        content?: Array<{ type?: string; text?: string }>;
      };
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== this.model) {
        throw new SemanticCandidateProviderDiagnosticError('malformed');
      }
      const content = body.content ?? [];
      const block = content[0];
      if (content.length !== 1 || !block || block.type !== 'text' || body.stop_reason !== 'end_turn' ||
          typeof block.text !== 'string' || block.text.length === 0) {
        throw new SemanticCandidateProviderDiagnosticError('incomplete');
      }
      return block.text;
    });
  }
}

async function completeProviderRequest(
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  request: (providerSignal: AbortSignal) => Promise<string>
): Promise<string> {
  const controller = new AbortController();
  let abortOrigin: 'external' | 'timeout' | undefined;
  const abort = () => {
    if (abortOrigin === undefined) {abortOrigin = 'external';}
    controller.abort();
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  const timeout = setTimeout(() => {
    if (abortOrigin === undefined) {abortOrigin = 'timeout';}
    controller.abort();
  }, requestTimeoutMs);
  try {
    if (abortOrigin === 'external') {
      throw new SemanticCandidateProviderDiagnosticError('cancelled');
    }
    const result = await request(controller.signal);
    if (abortOrigin !== undefined) {
      throw new SemanticCandidateProviderDiagnosticError(diagnosticForAbortOrigin(abortOrigin));
    }
    return result;
  } catch (error) {
    if (error instanceof SemanticCandidateProviderDiagnosticError) {
      throw error;
    }
    throw new SemanticCandidateProviderDiagnosticError(diagnosticForProviderError(abortOrigin, error));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export interface ConfiguredSemanticCandidateModelIdentity {
  readonly provider: 'openai-compatible' | 'anthropic';
  readonly endpoint_sha256: string;
  readonly model_sha256: string;
  readonly catalog_projection_sha256: string;
  readonly prompt_sha256: string;
  readonly schema_sha256: string;
  readonly request_config_sha256: string;
}

interface ConfiguredSemanticCandidateModel extends ConfiguredSemanticCandidateModelIdentity {
  readonly base_url: string;
  readonly api_key: string;
  readonly model: string;
  readonly request_timeout_ms: number;
}

function readConfiguredModel(env: NodeJS.ProcessEnv): ConfiguredSemanticCandidateModel {
  const provider = parseConfiguredProvider(env.F1QL_SEMANTIC_CANDIDATE_LLM_PROVIDER);
  const baseUrl = env.F1QL_SEMANTIC_CANDIDATE_LLM_BASE_URL;
  const apiKey = env.F1QL_SEMANTIC_CANDIDATE_LLM_API_KEY;
  const model = env.F1QL_SEMANTIC_CANDIDATE_MODEL;
  if (env.F1QL_SEMANTIC_CANDIDATE_MODEL_STRICT_JSON_SCHEMA !== 'true' || !baseUrl || !apiKey || !model) {
    throw new SemanticCandidateProviderConfigurationError('Strict semantic candidate provider is not supported or configured');
  }
  const validatedBaseUrl = provider === 'anthropic'
    ? validateAnthropicEndpoint(baseUrl)
    : validateEndpoint(baseUrl);
  const validatedModel = validateModel(model);
  const timeoutValue = env.F1QL_SEMANTIC_CANDIDATE_TIMEOUT_MS;
  const timeout = timeoutValue === undefined ? 10_000 : Number(timeoutValue);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider timeout is invalid');
  }
  return {
    provider,
    endpoint_sha256: sha256(validatedBaseUrl),
    model_sha256: sha256(validatedModel),
    catalog_projection_sha256: SEMANTIC_CANDIDATE_CATALOG_PROJECTION_SHA256,
    prompt_sha256: SEMANTIC_CANDIDATE_PROMPT_SHA256,
    schema_sha256: provider === 'anthropic'
      ? SEMANTIC_CANDIDATE_ANTHROPIC_SCHEMA_SHA256
      : SEMANTIC_CANDIDATE_SCHEMA_SHA256,
    request_config_sha256: sha256(stableSerialize(provider === 'anthropic'
      ? {
          anthropic_version: ANTHROPIC_API_VERSION,
          max_tokens: 8_192,
          output_format: 'json_schema',
          temperature: 0,
          timeout_ms: timeout
        }
      : {
          max_tokens: OPENAI_COMPATIBLE_MAX_TOKENS,
          response_format: {
            type: OPENAI_COMPATIBLE_RESPONSE_FORMAT,
            json_schema: {
              name: SEMANTIC_CANDIDATE_SCHEMA_NAME,
              strict: OPENAI_COMPATIBLE_STRICT_SCHEMA
            }
          },
          temperature: OPENAI_COMPATIBLE_TEMPERATURE,
          timeout_ms: timeout
        })),
    base_url: validatedBaseUrl,
    api_key: apiKey,
    model: validatedModel,
    request_timeout_ms: timeout
  };
}

function parseConfiguredProvider(input: string | undefined): ConfiguredSemanticCandidateModelIdentity['provider'] {
  if (input === 'openai-compatible' || input === 'anthropic') {
    return input;
  }
  throw new SemanticCandidateProviderConfigurationError('Strict semantic candidate provider is not supported or configured');
}

export function getConfiguredSemanticCandidateModelIdentity(
  env: NodeJS.ProcessEnv = process.env
): ConfiguredSemanticCandidateModelIdentity {
  const configured = readConfiguredModel(env);
  return Object.freeze({
    provider: configured.provider,
    endpoint_sha256: configured.endpoint_sha256,
    model_sha256: configured.model_sha256,
    catalog_projection_sha256: configured.catalog_projection_sha256,
    prompt_sha256: configured.prompt_sha256,
    schema_sha256: configured.schema_sha256,
    request_config_sha256: configured.request_config_sha256
  });
}

export function createSemanticCandidateModel(
  env: NodeJS.ProcessEnv = process.env
): SemanticCandidateModel {
  const configured = readConfiguredModel(env);
  const Model = configured.provider === 'anthropic'
    ? AnthropicSemanticCandidateModel
    : OpenAICompatibleSemanticCandidateModel;
  return new Model(
    configured.base_url,
    configured.api_key,
    configured.model,
    configured.request_timeout_ms
  );
}

export function buildSemanticCandidateProviderRequest(
  questionInput: unknown
): SemanticCandidateProviderRequest {
  const request = buildSemanticCandidateProposalRequest(questionInput);
  return deepFreeze({
    ...request,
    catalog: SEMANTIC_CANDIDATE_CATALOG_PROJECTION
  });
}

export function buildSemanticCandidateProposalRequest(
  questionInput: unknown
): SemanticCandidateProposalRequest {
  const question = createAnswerQuestionContract(questionInput);
  return deepFreeze({
    question: question.normalized_question,
    semantic_query_version: SEMANTIC_QUERY_VERSION,
    max_candidates: SEMANTIC_QUERY_MAX_CANDIDATES
  });
}

export class SemanticCandidateProposalAdapter {
  constructor(private readonly model: SemanticCandidateModel) {}

  async propose(
    request: SemanticCandidateProposalRequest,
    signal?: AbortSignal
  ): Promise<SemanticQueryCandidateSet> {
    let providerRequest: SemanticCandidateProviderRequest;
    try {
      if (request.semantic_query_version !== SEMANTIC_QUERY_VERSION ||
          request.max_candidates !== SEMANTIC_QUERY_MAX_CANDIDATES) {
        throw new Error('unsupported semantic candidate proposal contract');
      }
      providerRequest = buildSemanticCandidateProviderRequest(request.question);
    } catch {
      throw new SemanticCandidateProposalError('schema_invalid');
    }

    let raw: string;
    try {
      raw = await this.model.complete(SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT, providerRequest, signal);
    } catch (error) {
      throw sanitizeProposalError(error, signal);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SemanticCandidateProposalError('malformed');
    }
    try {
      return hydrateSemanticCandidateProposals(parsed, providerRequest.question);
    } catch (error) {
      throw sanitizeInvalidProposalError(error);
    }
  }
}

export function hydrateSemanticCandidateProposals(
  input: unknown,
  questionInput: unknown,
  catalog: SemanticCatalog = SEMANTIC_CATALOG
): SemanticQueryCandidateSet {
  if (containsForbiddenProviderMaterial(input)) {
    throw new SemanticCandidateProviderDiagnosticError('forbidden_output');
  }
  const proposalSet = proposalSetSchema.parse(input);
  const question = createAnswerQuestionContract(questionInput);
  const candidates = proposalSet.candidates.map(proposal => hydrateProposal(proposal, question, catalog));
  return parseSemanticQueryCandidateSet({ version: SEMANTIC_QUERY_VERSION, candidates }, question.normalized_question, catalog);
}

function hydrateProposal(
  proposal: z.infer<typeof proposalSchema>,
  question: AnswerQuestionContract,
  catalog: SemanticCatalog
) {
  return {
    version: SEMANTIC_QUERY_VERSION,
    outputs: proposal.outputs.map(output => ({
      kind: output.operation === 'select' ? 'concept' : 'aggregate',
      concept: toSemanticConceptRef(output.concept, catalog),
      ...(output.operation === 'aggregate' ? { function: output.function } : {}),
      evidence: hydrateEvidence(output.evidence, question)
    })),
    scopes: proposal.scopes.map(scope => hydrateScope(scope, question)),
    entities: proposal.entities.map(entity => ({ type: entity.type, span: hydrateSpan(entity.span, question) })),
    filters: proposal.filters.map(filter => hydrateFilter(filter, question, catalog)),
    group_by: proposal.group_by.map(group => ({
      concept: toSemanticConceptRef(group.concept, catalog), evidence: hydrateEvidence(group.evidence, question)
    })),
    ...(proposal.comparison === null ? {} : {
      comparison: { relation: proposal.comparison.operation, evidence: hydrateEvidence(proposal.comparison.evidence, question) }
    }),
    order_by: proposal.order_by.map(order => ({
      output_index: order.output_index, direction: order.direction, evidence: hydrateEvidence(order.evidence, question)
    })),
    ...(proposal.limit === null ? {} : {
      limit: { value: hydrateLimit(proposal.limit.evidence, question), evidence: hydrateEvidence(proposal.limit.evidence, question) }
    })
  };
}

export async function translateSemanticCandidateQuestion(
  questionInput: unknown,
  evidence: SemanticEvidence,
  model: SemanticCandidateModel,
  signal?: AbortSignal
): Promise<SemanticCandidateTranslationResult> {
  const question = createAnswerQuestionContract(questionInput);
  let hydrated: SemanticQueryCandidateSet;
  try {
    hydrated = await new SemanticCandidateProposalAdapter(model).propose(
      buildSemanticCandidateProposalRequest(question.normalized_question),
      signal
    );
  } catch (error) {
    const diagnostic = error instanceof SemanticCandidateProposalError ? error.code : 'transport';
    const reason = providerFailureReason(diagnostic);
    return providerUnavailable(reason, diagnostic);
  }
  return admitSemanticQueryCandidates(hydrated, question.normalized_question, evidence);
}

function hydrateScope(
  scope: z.infer<typeof scopeProposalSchema>,
  question: AnswerQuestionContract
): Record<string, unknown> {
  const evidence = hydrateEvidence(scope.evidence, question);
  if (scope.operation === 'season') {
    return { kind: 'season', value: uniqueMentionValue(question.years, evidence, 'season'), evidence };
  }
  if (scope.operation === 'round') {
    return { kind: 'round', value: uniqueMentionValue(question.rounds, evidence, 'round'), evidence };
  }
  if (scope.operation === 'session') {
    return { kind: 'session', source_id: scope.source_ref, value: scope.value, evidence };
  }
  if (scope.operation === 'temporal') {
    return { kind: 'temporal', value: scope.value, evidence };
  }
  return { kind: 'event', entity_index: scope.entity_index, evidence };
}

function hydrateFilter(
  filter: z.infer<typeof filterProposalSchema>,
  question: AnswerQuestionContract,
  catalog: SemanticCatalog
): Record<string, unknown> {
  const concept = toSemanticConceptRef(filter.concept, catalog);
  const evidence = hydrateEvidence(filter.evidence, question);
  if (filter.operation === 'entity_filter') {
    return { kind: 'entity', concept, operator: filter.operator, entity_indices: filter.entity_indices, evidence };
  }
  if (filter.operation === 'literal_filter') {
    const valueSpan = hydrateSpan(filter.value_span, question);
    return {
      kind: 'literal', concept, operator: 'eq', value: hydrateLiteral(valueSpan.text, concept, catalog),
      evidence: mergeEvidence(evidence, [valueSpan])
    };
  }
  if (filter.operation === 'literal_set_filter') {
    const valueSpans = filter.value_spans.map(span => hydrateSpan(span, question));
    return {
      kind: 'literal_set', concept, operator: 'in',
      values: valueSpans.map(span => hydrateLiteral(span.text, concept, catalog)),
      evidence: mergeEvidence(evidence, valueSpans)
    };
  }
  const minSpan = hydrateSpan(filter.min_span, question);
  const maxSpan = hydrateSpan(filter.max_span, question);
  return {
    kind: 'literal_range', concept, operator: 'range',
    min: hydrateLiteral(minSpan.text, concept, catalog),
    max: hydrateLiteral(maxSpan.text, concept, catalog),
    evidence: mergeEvidence(evidence, [minSpan, maxSpan])
  };
}

function hydrateLiteral(
  text: string,
  reference: { readonly source_id: string; readonly concept_id: string },
  catalog: SemanticCatalog
): string | number | boolean {
  const source = catalog.sources.find(item => item.id === reference.source_id);
  const concept = [...(source?.dimensions ?? []), ...(source?.measures ?? [])]
    .find(item => item.id === reference.concept_id);
  if (!concept) {
    throw new Error('unknown semantic concept reference');
  }
  if (['driver_id', 'event_id', 'circuit_id', 'identity', 'team_id'].includes(concept.semantic_type)) {
    throw new Error('identity literals cannot be proposed');
  }
  const normalized = text.normalize('NFKC').trim();
  if (concept.semantic_type === 'boolean') {
    if (!/^(?:true|false)$/iu.test(normalized)) {throw new Error('invalid boolean literal span');}
    return normalized.toLocaleLowerCase('en-US') === 'true';
  }
  if (['duration_ms', 'number', 'position', 'round', 'season'].includes(concept.semantic_type)) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalized)) {throw new Error('invalid numeric literal span');}
    const value = Number(normalized);
    if (!Number.isFinite(value) || (concept.semantic_type !== 'number' && !Number.isInteger(value))) {
      throw new Error('invalid numeric literal span');
    }
    return value;
  }
  if (concept.semantic_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error('invalid date literal span');
  }
  if ('allowed_values' in concept && concept.allowed_values.length > 0) {
    const allowed = concept.allowed_values.find(value => value.toLocaleLowerCase('en-US') === normalized.toLocaleLowerCase('en-US'));
    if (!allowed) {throw new Error('literal is outside the closed concept values');}
    return allowed;
  }
  if (!normalized || Array.from(normalized).length > 200) {throw new Error('invalid text literal span');}
  return normalized;
}

function hydrateLimit(
  evidenceRefs: readonly z.infer<typeof spanRefSchema>[],
  question: AnswerQuestionContract
): number {
  const matches = hydrateEvidence(evidenceRefs, question).flatMap(span =>
    [...span.text.matchAll(/\d{1,3}/gu)].map(match => Number(match[0]))
  );
  const values = [...new Set(matches)];
  if (values.length !== 1 || values[0] < 1 || values[0] > 100) {
    throw new Error('limit must be uniquely grounded by a bounded literal span');
  }
  return values[0];
}

function uniqueMentionValue(
  mentions: readonly { readonly value: number; readonly start: number; readonly end: number }[],
  evidence: readonly { readonly start: number; readonly end: number }[],
  kind: 'season' | 'round'
): number {
  const matches = mentions.filter(mention => evidence.some(span =>
    span.start <= mention.start && span.end >= mention.end
  ));
  const values = [...new Set(matches.map(match => match.value))];
  if (values.length !== 1) {
    throw new Error(`${kind} must be uniquely grounded by its literal span`);
  }
  return values[0];
}

function toSemanticConceptRef(
  reference: z.infer<typeof conceptRefSchema>,
  catalog: SemanticCatalog
): { readonly source_id: 'driver_standings' | 'event_classification' | 'event_metadata' | 'qualifying_classification'; readonly concept_id: string } {
  const source = catalog.sources.find(item => item.id === reference.source_ref && item.usage === 'answer_fact');
  const concept = [...(source?.dimensions ?? []), ...(source?.measures ?? [])]
    .find(item => item.id === reference.concept_ref && item.language !== null);
  if (!source || !concept) {
    throw new Error('provider referenced a concept outside the language catalog');
  }
  return { source_id: reference.source_ref, concept_id: reference.concept_ref };
}

function hydrateEvidence(
  refs: readonly z.infer<typeof spanRefSchema>[],
  question: AnswerQuestionContract
) {
  return refs.map(ref => hydrateSpan(ref, question));
}

function hydrateSpan(
  ref: z.infer<typeof spanRefSchema>,
  question: AnswerQuestionContract
) {
  const points = Array.from(question.normalized_question);
  if (ref.end > points.length) {
    throw new Error('provider span is outside the normalized question');
  }
  const text = points.slice(ref.start, ref.end).join('');
  if (!text) {
    throw new Error('provider span is empty');
  }
  return { text, start: ref.start, end: ref.end };
}

function mergeEvidence<T extends { readonly text: string; readonly start: number; readonly end: number }>(
  first: readonly T[],
  second: readonly T[]
): T[] {
  const unique = new Map([...first, ...second].map(span => [`${span.start}:${span.end}:${span.text}`, span]));
  return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end || compareText(left.text, right.text));
}

async function readBoundedProviderResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > SEMANTIC_CANDIDATE_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new SemanticCandidateProviderDiagnosticError('oversize');
  }
  if (!response.body) {
    throw new SemanticCandidateProviderDiagnosticError('malformed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {break;}
    size += result.value.byteLength;
    if (size > SEMANTIC_CANDIDATE_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SemanticCandidateProviderDiagnosticError('oversize');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SemanticCandidateProviderDiagnosticError('malformed');
  }
}

function containsForbiddenProviderMaterial(value: unknown, ancestors = new WeakSet<object>()): boolean {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {return true;}
    ancestors.add(value);
    const forbidden = value.some(child => containsForbiddenProviderMaterial(child, ancestors));
    ancestors.delete(value);
    return forbidden;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) {return true;}
    ancestors.add(value);
    const forbidden = Object.entries(value as Record<string, unknown>).some(([key, child]) =>
      isForbiddenProviderKey(key) || containsForbiddenProviderMaterial(child, ancestors)
    );
    ancestors.delete(value);
    return forbidden;
  }
  if (typeof value !== 'string') {return false;}
  return /\bf1ql\b|\bcore\s*(?:ir)?\b|\bphysical(?:_|\s)+(?:field|type|source)\b|\b(?:view|join)\b|\b(?:select|insert|delete|update|drop|alter|create)\b[\s\S]*\b(?:from|into|table|view|set)\b/iu.test(value) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(value);
}

function isForbiddenProviderKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return /(?:^|_)(?:sql|f1ql|core|physical|view|join|canonical|catalog|projection|admission)(?:_|$)/u.test(normalized) ||
    /^(?:driver|event|team|circuit)_?id$/u.test(normalized) ||
    /^(?:selected|resolved)_id$/u.test(normalized) || normalized === 'entity_inventory';
}

function sanitizeProposalError(error: unknown, signal?: AbortSignal): SemanticCandidateProposalError {
  if (error instanceof SemanticCandidateProviderDiagnosticError) {
    return new SemanticCandidateProposalError(error.diagnosticCode);
  }
  return new SemanticCandidateProposalError(diagnosticForProviderError(
    signal?.aborted ? 'external' : undefined,
    error
  ));
}

function diagnosticForProviderError(
  abortOrigin: 'external' | 'timeout' | undefined,
  error: unknown
): SemanticCandidateProviderDiagnosticCode {
  if (abortOrigin === 'external') {return 'cancelled';}
  if (abortOrigin === 'timeout' || isAbortError(error)) {return 'request_timeout';}
  return 'transport';
}

function providerFailureReason(
  diagnostic: SemanticCandidateProviderDiagnosticCode
): 'provider_error' | 'invalid_response' | 'incomplete_response' {
  if (diagnostic === 'incomplete') {return 'incomplete_response';}
  if (['forbidden_output', 'malformed', 'schema_invalid'].includes(diagnostic)) {return 'invalid_response';}
  return 'provider_error';
}

function sanitizeInvalidProposalError(error: unknown): SemanticCandidateProposalError {
  return new SemanticCandidateProposalError(
    error instanceof SemanticCandidateProviderDiagnosticError ? error.diagnosticCode : 'schema_invalid'
  );
}

function providerUnavailable(
  reason: 'provider_error' | 'invalid_response' | 'incomplete_response',
  diagnosticCode: SemanticCandidateProviderDiagnosticCode
): Extract<SemanticCandidateTranslationResult, { type: 'provider_unavailable' }> {
  return { type: 'provider_unavailable', reason, diagnostic_code: diagnosticCode };
}

function diagnosticForStatus(status: number): SemanticCandidateProviderDiagnosticCode {
  if (status === 401 || status === 403) {return 'auth';}
  if (status === 402) {return 'quota';}
  if (status === 429) {return 'rate_limit';}
  if (status >= 500) {return 'server';}
  return 'client';
}

function diagnosticForAbortOrigin(origin: 'external' | 'timeout'): SemanticCandidateProviderDiagnosticCode {
  return origin === 'external' ? 'cancelled' : 'request_timeout';
}

function validateEndpoint(baseUrl: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider endpoint must use HTTPS without credentials, query, or hash');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      baseUrl.includes('?') || baseUrl.includes('#') || endpoint.port && endpoint.port !== '443' ||
      isPrivateEndpointHostname(endpoint.hostname)) {
    throw new SemanticCandidateProviderConfigurationError('Semantic candidate provider endpoint must use HTTPS without credentials, query, or hash');
  }
  return endpoint.toString().replace(/\/$/u, '');
}

function validateAnthropicEndpoint(baseUrl: string): string {
  const endpoint = validateEndpoint(baseUrl);
  if (endpoint !== ANTHROPIC_BASE_URL) {
    throw new SemanticCandidateProviderConfigurationError(
      `Anthropic semantic candidate provider endpoint must be ${ANTHROPIC_BASE_URL}`
    );
  }
  return endpoint;
}

function isPrivateEndpointHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US').replace(/^\[|\]$|\.$/gu, '');
  return isIP(normalized) !== 0 || normalized === 'localhost' ||
    normalized.endsWith('.localhost') || normalized.endsWith('.local') ||
    normalized.endsWith('.internal') || normalized.endsWith('.home.arpa');
}

function validateModel(model: string): string {
  const normalized = model.trim();
  if (!normalized || normalized.length > 200 || Array.from(normalized).some(character => {
    const point = character.codePointAt(0) as number;
    return point <= 0x20 || point === 0x7f;
  })) {
    throw new SemanticCandidateProviderConfigurationError('Semantic candidate model identity is invalid');
  }
  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error &&
    (error as { readonly name?: unknown }).name === 'AbortError';
}

function copyLanguage(language: CatalogLanguage): CatalogLanguage {
  return {
    names: [...language.names],
    synonyms: [...language.synonyms],
    abbreviations: [...language.abbreviations],
    ambiguity_groups: [...language.ambiguity_groups],
    forbidden_conflations: [...language.forbidden_conflations]
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toAnthropicWireSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toAnthropicWireSchema);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const transformed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (['minimum', 'maximum', 'maxItems'].includes(key) ||
        key === 'minItems' && typeof child === 'number' && child > 1) {
      continue;
    }
    if (key === 'anyOf' && Array.isArray(child)) {
      transformed[key] = child
        .filter(branch => !isEmptyArrayCompatibilitySchema(branch))
        .map(toAnthropicWireSchema);
      continue;
    }
    transformed[key] = toAnthropicWireSchema(child);
  }
  return transformed;
}

function isEmptyArrayCompatibilitySchema(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'array' &&
    (value as Record<string, unknown>).maxItems === 0;
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
