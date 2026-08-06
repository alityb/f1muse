import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAnswerQuestionContract } from '../src/f1ql/answer-question';
import {
  canonicalizeHiddenHoldoutJson,
  decodeHiddenHoldoutEnvironment,
  evaluateHiddenHoldout,
  HIDDEN_HOLDOUT_PAYLOAD_ENV,
  HIDDEN_HOLDOUT_SHA256_ENV,
  HiddenHoldoutError,
  parseHiddenHoldoutPayload
} from '../scripts/run-phase11-hidden-holdout';
import { emitHiddenHoldoutMetadata } from '../scripts/snapshot-phase11-hidden-placeholder';

const QUESTION = 'Give driver and championship points from 2023 final driver standings.';

describe('Phase 11 guarded hidden holdout', () => {
  it('fails clearly when material or its independent digest is absent or mismatched', () => {
    expect(() => decodeHiddenHoldoutEnvironment({})).toThrowError(expect.objectContaining({ code: 'material_absent' }));
    expect(() => decodeHiddenHoldoutEnvironment({
      [HIDDEN_HOLDOUT_PAYLOAD_ENV]: Buffer.from('{}').toString('base64')
    })).toThrowError(expect.objectContaining({ code: 'digest_absent' }));
    expect(() => decodeHiddenHoldoutEnvironment({
      [HIDDEN_HOLDOUT_PAYLOAD_ENV]: Buffer.from('{}').toString('base64'),
      [HIDDEN_HOLDOUT_SHA256_ENV]: '0'.repeat(64)
    })).toThrowError(expect.objectContaining({ code: 'hash_mismatch' }));
  });

  it('accepts only exact canonical UTF-8 JSON bytes', () => {
    const payload = validPayload();
    const canonical = canonicalizeHiddenHoldoutJson(payload);
    expect(decodeText(canonical)).toMatchObject({ payload_sha256: sha256(Buffer.from(canonical)) });

    expectCode(() => decodeText(JSON.stringify(payload)), 'payload_noncanonical');
    expectCode(() => decodeText(`${canonical}\n`), 'payload_noncanonical');
    expectCode(() => decodeText('{"cases":[],"cases":[],"contract_version":"phase11-wp7-hidden-holdout-v1","schema_version":1}'), 'payload_noncanonical');

    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    expectCode(() => decodeBytes(invalidUtf8), 'json_invalid');
  });

  it('enforces the strict hidden schema without caller-supplied public-set overrides', () => {
    const payload = validPayload();
    expect(parseHiddenHoldoutPayload(payload).cases).toHaveLength(1);

    const wrongSplit = structuredClone(payload) as any;
    wrongSplit.cases[0].split = 'public_holdout';
    expectCode(() => parseHiddenHoldoutPayload(wrongSplit), 'schema_invalid');

    const templateBound = structuredClone(payload) as any;
    templateBound.cases[0].expected.template_id = 'final_standings_points';
    expectCode(() => parseHiddenHoldoutPayload(templateBound), 'template_identifier_forbidden');

    const malformedStructure = structuredClone(payload) as any;
    malformedStructure.cases[0].structure.operations = ['source', 'filter', 'sort', 'limit'];
    expectCode(() => parseHiddenHoldoutPayload(malformedStructure), 'structure_invalid');

    const duplicateId = structuredClone(payload) as any;
    duplicateId.cases.push(structuredClone(duplicateId.cases[0]));
    expectCode(() => parseHiddenHoldoutPayload(duplicateId), 'duplicate_case_id');

    const duplicateQuestion = structuredClone(payload) as any;
    duplicateQuestion.cases.push({ ...structuredClone(duplicateQuestion.cases[0]), id: 'hidden-standings-second' });
    expectCode(() => parseHiddenHoldoutPayload(duplicateQuestion), 'duplicate_question_hash');

    const publicQuestion = 'List driver and championship points from final 2025 driver standings.';
    const overlap = structuredClone(payload) as any;
    overlap.cases[0].question = publicQuestion;
    overlap.cases[0].question_sha256 = createAnswerQuestionContract(publicQuestion).sha256;
    expectCode(() => parseHiddenHoldoutPayload(overlap), 'public_corpus_overlap');
  });

  it('binds evaluation to active decoded bytes and rejects public plan-structure paraphrases', async () => {
    await expect(evaluateHiddenHoldout({
      payload_sha256: 'a'.repeat(64),
      payload_bytes: 1
    })).rejects.toEqual(expect.objectContaining({ code: 'material_provenance_invalid' }));

    const material = decodeCanonicalPayload(validPayload());
    await expect(evaluateHiddenHoldout(material)).rejects.toEqual(expect.objectContaining({
      code: 'public_plan_structure_overlap',
      message: 'hidden holdout public plan structure overlap'
    }));
    await expect(evaluateHiddenHoldout(material)).rejects.not.toThrow(QUESTION);

    const unreviewed = structuredClone(validPayload()) as any;
    unreviewed.cases[0].question = 'Give driver and championship position from 2023 final driver standings.';
    unreviewed.cases[0].question_sha256 = createAnswerQuestionContract(unreviewed.cases[0].question).sha256;
    unreviewed.cases[0].structure.output_concept_ids = [
      'driver_standings.driver_id', 'driver_standings.championship_position'
    ];
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(unreviewed))).rejects.toEqual(
      expect.objectContaining({ code: 'capability_interaction_not_reviewed' })
    );
  });

  it('exactly matches the real zero-content metadata emitter', () => {
    const source = readFileSync('metadata/phase11-wp7-hidden-holdout.json', 'utf8');
    const metadata = JSON.parse(source);
    expect(emitHiddenHoldoutMetadata()).toBe(source);
    expect(metadata.committed_content.case_count).toBe(0);
    expect(metadata.runtime_contract.current_supported_gate_status).toContain('blocked_until');
    expect(metadata.zero_content_placeholder.runtime_evaluable).toBe(false);
  });

  it('recognizes a single-source scalar aggregate before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show count of qualifying position in final 2024 qualifying classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-qualifying-count-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: ['qualifying_classification.qualifying_position']
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes a grouped aggregate rank before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show top 10 drivers by count of qualifying position in final 2024 qualifying classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-qualifying-count-ranking-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: [
          'qualifying_classification.driver_id',
          'qualifying_classification.qualifying_position'
        ]
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes a race grouped aggregate rank before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show top 10 drivers by count of finishing position in final 2024 race classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-race-count-ranking-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['event_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['event_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: [
          'event_classification.driver_id',
          'event_classification.finishing_position'
        ]
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes selected race grouped counts before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show driver and count of finishing position for Charles Leclerc and George Russell in final 2024 race classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-selected-race-count-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      entities: [
        { type: 'driver', text: 'Charles Leclerc' },
        { type: 'driver', text: 'George Russell' }
      ],
      resolver: {
        driver_mentions: [
          { text: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] },
          { text: 'George Russell', candidates: ['george-russell'], active_candidates: ['george-russell'] }
        ],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['event_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['event_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: [
          'event_classification.driver_id',
          'event_classification.finishing_position'
        ]
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes selected qualifying grouped counts before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show driver and count of qualifying position for Charles Leclerc and George Russell in final 2024 qualifying classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-selected-qualifying-count-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      entities: [
        { type: 'driver', text: 'Charles Leclerc' },
        { type: 'driver', text: 'George Russell' }
      ],
      resolver: {
        driver_mentions: [
          { text: 'Charles Leclerc', candidates: ['charles-leclerc'], active_candidates: ['charles-leclerc'] },
          { text: 'George Russell', candidates: ['george-russell'], active_candidates: ['george-russell'] }
        ],
        event_resolution: { type: 'missing' }
      },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['qualifying_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: [
          'qualifying_classification.driver_id',
          'qualifying_classification.qualifying_position'
        ]
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes the race-source scalar aggregate before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show count of finishing position in final 2024 race classification.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-race-count-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_aggregate',
        source_ids: ['event_classification'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_aggregate',
        source_ids: ['event_classification'],
        operations: ['source', 'filter', 'aggregate', 'project', 'sort', 'limit'],
        output_concept_ids: ['event_classification.finishing_position']
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('recognizes the zero-driver aggregate-locality plan before enforcing hidden structure independence', async () => {
    const payload: any = validPayload();
    const question = 'Show count of finishing position from race classification and count of qualifying position from qualifying classification in final 2024.';
    payload.cases[0] = {
      ...payload.cases[0],
      id: 'hidden-unfiltered-dual-count-2024',
      question,
      question_sha256: createAnswerQuestionContract(question).sha256,
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'scalar_aggregate_compose',
        source_ids: ['event_classification', 'qualifying_classification'],
        plan_family: 'aggregate_locality'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'scalar_aggregate_compose',
        source_ids: ['event_classification', 'qualifying_classification'],
        operations: ['source', 'filter', 'aggregate', 'compose', 'project', 'sort', 'limit'],
        output_concept_ids: [
          'event_classification.finishing_position',
          'qualifying_classification.qualifying_position'
        ]
      }
    };
    await expect(evaluateHiddenHoldout(decodeCanonicalPayload(payload))).rejects.toEqual(
      expect.objectContaining({ code: 'public_plan_structure_overlap' })
    );
  });

  it('wires a protected manual release without database or secret output paths', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const workflow = readFileSync('.github/workflows/phase11-hidden-holdout.yml', 'utf8');
    const runner = readFileSync('scripts/run-phase11-hidden-holdout.ts', 'utf8');

    expect(packageJson.scripts['release:phase11:hidden-holdout']).toBe('tsx scripts/run-phase11-hidden-holdout.ts');
    expect(packageJson.scripts['golden:snapshot:phase11:hidden-placeholder'])
      .toBe('tsx scripts/snapshot-phase11-hidden-placeholder.ts');
    expect(workflow).toMatch(/workflow_dispatch|environment: phase11-hidden-holdout/u);
    expect(workflow).toContain('npm run release:phase11:hidden-holdout');
    expect(workflow).toContain('npm run test:f1ql');
    expect(workflow).not.toMatch(/echo[^\n]*\$\{?F1MUSE_PHASE11_HIDDEN_HOLDOUT_(?:BASE64|SHA256)/u);
    expect(runner).not.toMatch(/from ['"](?:pg|[^'"]*executor|[^'"]*database)[^'"]*['"]/u);
    expect(runner).not.toMatch(/executeF1QL|new\s+Pool|\.query\s*\(/u);
  });
});

function validPayload(): unknown {
  return {
    schema_version: 1,
    contract_version: 'phase11-wp7-hidden-holdout-v1',
    cases: [{
      id: 'hidden-standings-2023',
      split: 'hidden_holdout',
      question: QUESTION,
      question_sha256: createAnswerQuestionContract(QUESTION).sha256,
      coverage_tags: ['plan_family_single_source'],
      risk_tags: ['template_free'],
      entities: [],
      provider_mode: 'enumerated',
      resolver: { driver_mentions: [], event_resolution: { type: 'missing' } },
      expected: {
        action: 'answer', reason: 'semantic_plan_proven', topology: 'single_source_rows',
        source_ids: ['driver_standings'], plan_family: 'single_source'
      },
      structure: {
        template_free: true,
        held_out_dimensions: ['season', 'wording', 'composition'],
        topology: 'single_source_rows',
        source_ids: ['driver_standings'],
        operations: ['source', 'filter', 'project', 'sort', 'limit'],
        output_concept_ids: ['driver_standings.driver_id', 'driver_standings.points']
      }
    }]
  };
}

function decodeCanonicalPayload(payload: unknown) {
  return decodeText(canonicalizeHiddenHoldoutJson(payload));
}

function decodeText(text: string) {
  return decodeBytes(Buffer.from(text, 'utf8'));
}

function decodeBytes(bytes: Buffer) {
  return decodeHiddenHoldoutEnvironment({
    [HIDDEN_HOLDOUT_PAYLOAD_ENV]: bytes.toString('base64'),
    [HIDDEN_HOLDOUT_SHA256_ENV]: sha256(bytes)
  });
}

function expectCode(action: () => unknown, code: HiddenHoldoutError['code']): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
