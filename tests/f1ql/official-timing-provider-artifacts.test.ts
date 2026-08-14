import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  generateOfficialTimingProviderArtifacts,
  OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR
} from '../../scripts/generate-official-timing-provider-artifacts';
import {
  SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
  SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
  SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256
} from '../../src/f1ql/semantic-candidate-selector';
import { WP12_OFFICIAL_TIMING_CATALOG_TARGET } from '../../src/f1ql/wp12-official-timing-catalog-target';
import { WP12_OFFICIAL_TIMING_INTERFACE_TARGET } from '../../src/f1ql/wp12-official-timing-interface-target';

const FIXTURE_PATH = 'tests/fixtures/wp12-official-timing-provider-artifacts.json';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('official timing provider selection v2 generated artifacts', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  it('regenerates the committed artifact byte-exactly', () => {
    const regenerated = generateOfficialTimingProviderArtifacts();
    expect(`${JSON.stringify(regenerated, null, 2)}\n`).toBe(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(fixture.generator).toBe(OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR);
    expect(fixture.candidate_selection_version).toBe(2);
    expect(fixture.schema_name).toBe(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME);
  });

  it('binds the sealed selection inputs exactly', () => {
    const provider = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.provider_schema.contract as any;
    expect(fixture.sealed_inputs.selection_schema_template_sha256)
      .toBe(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256);
    expect(fixture.sealed_inputs.selection_prompt_sha256).toBe(SEMANTIC_CANDIDATE_SELECTION_PROMPT_SHA256);
    expect(fixture.sealed_inputs.catalog_v2_sha256).toBe(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256);
    expect(provider.selection_schema_template_sha256).toBe(SEMANTIC_CANDIDATE_SELECTION_SCHEMA_SHA256);
    expect(provider.candidate_projection_sha256).toBe(SEMANTIC_CANDIDATE_SELECTION_PROJECTION_SHA256);
  });

  it('hashes match their canonical content and the interface pins', () => {
    const { artifacts, artifact_hashes: hashes } = fixture;
    expect(hashes.candidate_projection_sha256).toBe(sha256(stableSerialize(artifacts.candidate_projection)));
    expect(hashes.effective_prompt_sha256).toBe(sha256(artifacts.effective_prompt));
    expect(hashes.openai_compatible_schema_template_sha256)
      .toBe(sha256(stableSerialize(artifacts.openai_compatible_schema_template)));
    expect(hashes.anthropic_wire_schema_template_sha256)
      .toBe(sha256(stableSerialize(artifacts.anthropic_wire_schema_template)));
    expect(hashes.provider_request_config_sha256).toBe(sha256(stableSerialize(artifacts.provider_request_config)));
    expect((WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.provider_schema.contract as any).generated_artifacts)
      .toMatchObject(hashes);
  });

  it('allows only a request-specific candidate ID in the provider response', () => {
    const schema = fixture.artifacts.openai_compatible_schema_template;
    expect(schema).toEqual(fixture.artifacts.anthropic_wire_schema_template);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['version', 'candidate_id'],
      properties: {
        version: { enum: [2] },
        candidate_id: { enum: ['<server-enumerated-candidate-id>'] }
      }
    });
    expect(JSON.stringify(schema)).not.toMatch(/span|operation|aggregate|filter|sql/iu);
  });

  it('seals the reduced provider reservation and server-owned projection', () => {
    expect(fixture.artifacts.provider_request_config).toMatchObject({
      schema_name: SEMANTIC_CANDIDATE_SELECTION_SCHEMA_NAME,
      strict_schema: true,
      dynamic_candidate_id_enum: true,
      max_tokens: SEMANTIC_CANDIDATE_SELECTION_MAX_TOKENS,
      temperature: 0
    });
    expect(fixture.artifacts.candidate_projection).toMatchObject({
      authority: 'server_enumerated_canonical_candidates',
      candidate_fields: ['candidate_id', 'semantic_query']
    });
  });
});
