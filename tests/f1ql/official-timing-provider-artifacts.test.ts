import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  generateOfficialTimingProviderArtifacts,
  OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR,
  OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION,
  OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA
} from '../../scripts/generate-official-timing-provider-artifacts';
import {
  SEMANTIC_CANDIDATE_SCHEMA_NAME,
  SEMANTIC_CANDIDATE_SCHEMA_SHA256
} from '../../src/f1ql/semantic-candidate-translator';
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

describe('official timing provider v2 generated artifacts', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  it('regenerates the committed artifact byte-exactly', () => {
    const regenerated = generateOfficialTimingProviderArtifacts();
    expect(`${JSON.stringify(regenerated, null, 2)}\n`).toBe(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(fixture.generator).toBe(OFFICIAL_TIMING_PROVIDER_ARTIFACT_GENERATOR);
    expect(fixture.candidate_proposal_version).toBe(2);
    expect(fixture.schema_name).toBe('f1_semantic_candidate_proposals_v2');
  });

  it('binds the sealed interface-target inputs exactly', () => {
    const providerContract = WP12_OFFICIAL_TIMING_INTERFACE_TARGET.components.provider_schema.contract as any;
    expect(fixture.sealed_inputs.official_variant_schema_sha256).toBe(providerContract.official_variant_schema_sha256);
    expect(fixture.sealed_inputs.prompt_extension_sha256).toBe(providerContract.prompt_extension_sha256);
    expect(fixture.sealed_inputs.predecessor_openai_schema_sha256).toBe(providerContract.predecessor_schema_sha256);
    expect(fixture.sealed_inputs.predecessor_openai_schema_sha256).toBe(SEMANTIC_CANDIDATE_SCHEMA_SHA256);
    expect(fixture.sealed_inputs.catalog_v2_sha256).toBe(WP12_OFFICIAL_TIMING_CATALOG_TARGET.catalog_sha256);
    expect(sha256(stableSerialize(OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA))).toBe(providerContract.official_variant_schema_sha256);
    expect(sha256(stableSerialize(OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION))).toBe(providerContract.prompt_extension_sha256);
    expect(SEMANTIC_CANDIDATE_SCHEMA_NAME).toBe('f1_semantic_candidate_proposals_v1');
  });

  it('hashes match their canonical content', () => {
    const { artifacts, artifact_hashes } = fixture;
    expect(artifact_hashes.catalog_language_projection_sha256)
      .toBe(sha256(stableSerialize(artifacts.catalog_language_projection)));
    expect(artifact_hashes.effective_prompt_sha256).toBe(sha256(artifacts.effective_prompt));
    expect(artifact_hashes.openai_compatible_schema_sha256)
      .toBe(sha256(stableSerialize(artifacts.openai_compatible_schema)));
    expect(artifact_hashes.anthropic_wire_schema_sha256)
      .toBe(sha256(stableSerialize(artifacts.anthropic_wire_schema)));
    expect(artifact_hashes.provider_request_config_sha256)
      .toBe(sha256(stableSerialize(artifacts.provider_request_config)));
  });

  it('extends the v1 candidate union with exactly the official variant', () => {
    const schema = fixture.artifacts.openai_compatible_schema;
    expect(schema.properties.version.enum).toEqual([2]);
    expect(schema.properties.candidates.maxItems).toBe(2);
    expect(schema.properties.candidates.items.anyOf).toHaveLength(2);
    expect(schema.properties.candidates.items.anyOf[1]).toEqual(OFFICIAL_TIMING_PROVIDER_VARIANT_SCHEMA);
    expect(schema.$defs.span_ref).toBeDefined();
    expect(schema.$defs.evidence_ref).toBeDefined();
    const anthropic = fixture.artifacts.anthropic_wire_schema;
    expect(anthropic.properties.candidates.items.anyOf).toHaveLength(2);
    expect(anthropic.properties.candidates.items.anyOf[1]).toBeDefined();
  });

  it('projects language only, with no physical or database details', () => {
    const projection = fixture.artifacts.catalog_language_projection;
    expect(projection.version).toBe(2);
    const sourceIds = projection.sources.map((source: any) => source.source_ref);
    expect(sourceIds).toContain('official_race_lap_timing');
    const text = JSON.stringify(projection);
    expect(text).not.toContain('physical_field');
    expect(text).not.toContain('f1ql.');
    expect(text).not.toContain('security_barrier');
    const official = projection.sources.find((source: any) => source.source_ref === 'official_race_lap_timing');
    expect(official.language.ambiguity_groups).toEqual(['official_timing']);
    expect(official.language.forbidden_conflations.length).toBeGreaterThan(0);
  });

  it('extends the predecessor prompt with exactly the sealed extension', () => {
    const prompt = fixture.artifacts.effective_prompt as string;
    expect(prompt.endsWith(OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION)).toBe(true);
    expect(prompt.length).toBeGreaterThan(OFFICIAL_TIMING_PROVIDER_PROMPT_EXTENSION.length);
    expect(fixture.artifacts.provider_request_config).toMatchObject({
      schema_name: 'f1_semantic_candidate_proposals_v2',
      strict_schema: true,
      max_response_bytes: 65_536,
      max_tokens: 8_192,
      temperature: 0
    });
  });
});
