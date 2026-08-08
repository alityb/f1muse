import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  SEMANTIC_CANDIDATE_JSON_SCHEMA,
  SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT,
  SEMANTIC_CANDIDATE_PROMPT_SHA256,
  SEMANTIC_CANDIDATE_SCHEMA_SHA256
} from '../src/f1ql/semantic-candidate-translator';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../src/f1ql/wp12-official-timing-catalog-target';

export const OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR = 'wp12-official-timing-provider-artifacts-v1' as const;
export const OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME = 'f1_semantic_candidate_proposals_v2' as const;

// Re-declared exactly as sealed in the interface target; the regeneration test cross-checks
// the canonical hashes against the target's pinned values.
export const OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'operation', 'driver_a_span', 'driver_b_span', 'event_span', 'operation_evidence',
    'season_evidence', 'lap_range_evidence'
  ],
  properties: {
    operation: { const: 'certified_official_timing_compare' },
    driver_a_span: { $ref: '#/$defs/span_ref' },
    driver_b_span: { $ref: '#/$defs/span_ref' },
    event_span: { $ref: '#/$defs/span_ref' },
    operation_evidence: { $ref: '#/$defs/evidence_ref' },
    season_evidence: { $ref: '#/$defs/evidence_ref' },
    lap_range_evidence: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false, required: ['start_span', 'end_span'],
          properties: {
            start_span: { $ref: '#/$defs/span_ref' },
            end_span: { $ref: '#/$defs/span_ref' }
          }
        }
      ]
    }
  }
} as const;

export const OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION = 'For the exact reviewed official timing grammar only, emit certified_official_timing_compare with two ordered driver spans, one event span, operation and season evidence, and nullable lap-range evidence. Session is server-derived from the verified grammar. Never emit a metric, aggregate, exclusion, identifier, topology, output, integrity rule, SQL, F1QL, or Core.';

const SPAN_REF_DEFINITION = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: { type: 'integer', minimum: 0, maximum: 1000 },
    end: { type: 'integer', minimum: 1, maximum: 1000 }
  }
} as const;
const EVIDENCE_REF_DEFINITION = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  items: { $ref: '#/$defs/span_ref' }
} as const;

function copyLanguage(language: {
  readonly names: readonly string[];
  readonly synonyms: readonly string[];
  readonly abbreviations: readonly string[];
  readonly ambiguity_groups: readonly string[];
  readonly forbidden_conflations: readonly string[];
}) {
  return {
    names: [...language.names],
    synonyms: [...language.synonyms],
    abbreviations: [...language.abbreviations],
    ambiguity_groups: [...language.ambiguity_groups],
    forbidden_conflations: [...language.forbidden_conflations]
  };
}

export function generateOfficialTimingProviderArtifacts() {
  const catalog = WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog;
  const projectionMaterial = {
    version: 2,
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
  const catalogLanguageProjection = {
    ...projectionMaterial,
    projection_sha256: sha256(stableSerialize(projectionMaterial))
  };

  const effectivePrompt = `${SEMANTIC_CANDIDATE_PROVIDER_SYSTEM_PROMPT} ${OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION}`;

  const v1 = SEMANTIC_CANDIDATE_JSON_SCHEMA as unknown as {
    properties: { candidates: { items: unknown } & Record<string, unknown> } & Record<string, unknown>;
    $defs: Record<string, unknown>;
  };
  const v1CandidateItems = v1.properties.candidates.items;
  const openaiSchema = deepFreeze({
    ...v1,
    properties: {
      ...v1.properties,
      version: { type: 'integer', enum: [2] },
      candidates: {
        ...v1.properties.candidates,
        maxItems: 2,
        items: { anyOf: [v1CandidateItems, OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA] }
      }
    },
    $defs: {
      ...v1.$defs,
      span_ref: SPAN_REF_DEFINITION,
      evidence_ref: EVIDENCE_REF_DEFINITION
    }
  });
  const anthropicSchema = deepFreeze(toAnthropicWireSchema(openaiSchema));

  const requestConfig = deepFreeze({
    schema_name: OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME,
    strict_schema: true,
    max_response_bytes: 65_536,
    max_tokens: 8_192,
    temperature: 0,
    timeout_ms_bounds: { min: 1, max: 30_000 },
    providers: {
      'openai-compatible': {
        response_format: {
          type: 'json_schema',
          json_schema: { name: OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME, strict: true }
        }
      },
      anthropic: {
        anthropic_version: '2023-06-01',
        output_format: 'json_schema'
      }
    }
  });

  return deepFreeze({
    generator: OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR,
    candidate_proposal_version: 2,
    schema_name: OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME,
    sealed_inputs: {
      predecessor_openai_schema_sha256: SEMANTIC_CANDIDATE_SCHEMA_SHA256,
      predecessor_prompt_sha256: SEMANTIC_CANDIDATE_PROMPT_SHA256,
      official_variant_schema_sha256: sha256(stableSerialize(OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA)),
      // Canonical (JSON-quoted) form to match the interface target's sealed pin.
      prompt_extension_sha256: sha256(stableSerialize(OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION)),
      catalog_v2_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256
    },
    artifacts: {
      catalog_language_projection: catalogLanguageProjection,
      effective_prompt: effectivePrompt,
      openai_compatible_schema: openaiSchema,
      anthropic_wire_schema: anthropicSchema,
      provider_request_config: requestConfig
    },
    artifact_hashes: {
      catalog_language_projection_sha256: sha256(stableSerialize(catalogLanguageProjection)),
      effective_prompt_sha256: sha256(effectivePrompt),
      openai_compatible_schema_sha256: sha256(stableSerialize(openaiSchema)),
      anthropic_wire_schema_sha256: sha256(stableSerialize(anthropicSchema)),
      provider_request_config_sha256: sha256(stableSerialize(requestConfig))
    }
  });
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
  return JSON.stringify(value);
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

async function main() {
  const artifact = generateOfficialTimingProviderArtifacts();
  writeFileSync(
    'tests/fixtures/wp12-official-timing-provider-artifacts.json',
    `${JSON.stringify(artifact, null, 2)}\n`
  );
  console.log('generated official timing provider v2 artifacts');
}

if (process.argv[1] && process.argv[1].endsWith('generate-official-timing-provider-artifacts.ts')) {
  void main();
}
