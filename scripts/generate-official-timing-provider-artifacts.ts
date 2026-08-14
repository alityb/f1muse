import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
  SEMANTIC_CANDIDATE_SELECTION_PROJECTION,
  SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_TEMPLATE,
  SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT,
  SEMANTIC_CANDIDATE_SELECTION_VERSION
} from '../src/f1ql/semantic-candidate-selector';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../src/f1ql/wp12-official-timing-catalog-target';

export const OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR =
  'wp12-official-timing-provider-selection-artifacts-v2' as const;
export const OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME = SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME;

export function generateOfficialTimingProviderArtifacts() {
  const openaiSchemaTemplate = deepFreeze(structuredClone(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_TEMPLATE));
  const anthropicSchemaTemplate = deepFreeze(structuredClone(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_TEMPLATE));
  const requestConfig = deepFreeze({
    schema_name: OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME,
    strict_schema: true,
    dynamic_candidate_id_enum: true,
    maximum_response_bytes: 65_536,
    max_tokens: SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
    temperature: 0,
    timeout_ms_bounds: { min: 1, max: 300_000 },
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
  const artifacts = deepFreeze({
    candidate_projection: structuredClone(SEMANTIC_CANDIDATE_SELECTION_PROJECTION),
    effective_prompt: SEMANTIC_CANDIDATE_SELECTION_SYSTEM_PROMPT,
    openai_compatible_schema_template: openaiSchemaTemplate,
    anthropic_wire_schema_template: anthropicSchemaTemplate,
    provider_request_config: requestConfig
  });

  return deepFreeze({
    generator: OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR,
    candidate_selection_version: SEMANTIC_CANDIDATE_SELECTION_VERSION,
    schema_name: OFFICIAL_TIMING_PROVIDER_SCHEMA_NAME,
    sealed_inputs: {
      selection_schema_template_sha256: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256,
      selection_prompt_sha256: SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
      catalog_v2_sha256: WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256
    },
    artifacts,
    artifact_hashes: {
      candidate_projection_sha256: sha256(stableSerialize(artifacts.candidate_projection)),
      effective_prompt_sha256: sha256(artifacts.effective_prompt),
      openai_compatible_schema_template_sha256:
        sha256(stableSerialize(artifacts.openai_compatible_schema_template)),
      anthropic_wire_schema_template_sha256:
        sha256(stableSerialize(artifacts.anthropic_wire_schema_template)),
      provider_request_config_sha256: sha256(stableSerialize(artifacts.provider_request_config))
    }
  });
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
  console.log('generated official timing provider selection v2 artifacts');
}

if (process.argv[1] && process.argv[1].endsWith('generate-official-timing-provider-artifacts.ts')) {
  void main();
}
