import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSemanticShadowReport,
  buildSemanticShadowReportFromJsonl,
  SemanticShadowReportRequirements
} from '../../src/f1ql/semantic-shadow-report';
import {
  computeSemanticShadowAttemptSha256,
  sanitizeSemanticShadowRetainedObservation
} from '../../src/f1ql/semantic-shadow-retained-observation';
import {
  reportSemanticShadowFile,
  reviewedSemanticShadowReportRequirements
} from '../../scripts/report-semantic-shadow';

const HASH = (character: string) => character.repeat(64);
const QUESTION_A = HASH('a');
const QUESTION_B = HASH('b');
const PROVIDER = Object.freeze({
  provider: 'openai-compatible' as const,
  endpoint_sha256: HASH('1'),
  model_sha256: HASH('2'),
  catalog_projection_sha256: HASH('3'),
  prompt_sha256: HASH('4'),
  schema_sha256: HASH('5'),
  request_config_sha256: HASH('6')
});

function answerObservation(totalMs: number, dualStatus: 'matched' | 'mismatched') {
  return {
    version: 'semantic-shadow-observation-v1',
    outcome: 'answer',
    reason: 'plan_proven',
    candidate_counts: {
      enumerated: 1, proposed: 1, matched: 1, omitted: 0, extraneous: 0, comparison: 'exact'
    },
    resolver_counts: {
      inventory_reads: 1, event_reads: 0, fingerprint_reads: 0,
      inventory_entities: 2, verified_candidates: 3
    },
    topology_code: 'single_source_rows',
    source_set_code: 'driver_standings',
    operator_set_code: 'filter_project_sort_limit',
    plan_work: {
      model: 'semantic-plan-work-v1', source_scan_units: 1, resolver_reads: 1,
      resolver_candidates: 3, sources: 1, row_joins: 0, compositions: 0,
      operator_depth: 4, requested_rows: 10
    },
    hashes: {
      catalog_sha256: HASH('a'), candidate_set_sha256: HASH('b'),
      provider_candidate_set_sha256: HASH('c'), semantic_evidence_sha256: HASH('d'),
      semantic_query_sha256: HASH('e'), answer_plan_sha256: HASH('f'),
      topology_sha256: HASH('0'), planned_f1ql_sha256: HASH('1'),
      core_sha256: HASH('2'), compiled_sha256: HASH('3'), semantic_proof_sha256: HASH('4')
    },
    template_dual: {
      enabled: true, status: dualStatus, template_id: 'final_standings_points',
      template_intent_sha256: HASH('5'), template_program_sha256: HASH('6'),
      template_proof_sha256: HASH('7')
    },
    latencies: { total_ms: totalMs },
    result_query_calls: 0,
    versions: {
      orchestrator: 'orchestrator-v1', observation: 'semantic-shadow-observation-v1',
      question_contract: 'question-v1', semantic_query: 2, semantic_evidence: 2,
      resolution: 'resolution-v1', planner: 'planner-v1', semantic_proof: 'proof-v1',
      planned_f1ql: 2, planned_compiler: 'compiler-v1', fact_space: 'facts-v1',
      template_intent: 'intent-v1', template_registry: 'registry-v1', template_proof: 'template-proof-v1'
    }
  };
}

function common(questionSha256: string, provider = PROVIDER) {
  return {
    version: 'semantic-shadow-retained-v2',
    timestamp: '2026-07-30T12:00:00.000Z',
    mode: 'semantic_shadow',
    rollout_stage: 0,
    question_sha256: questionSha256,
    provider_identity: provider,
    resolver_transaction_count: 1,
    resolver_transaction_counters: {
      statement_count: 1,
      returned_row_count: 2,
      statements: {
        driver_inventory_unscoped: 0, driver_inventory_scoped: 1,
        event_name: 0, event_round: 0
      }
    }
  };
}

function semanticRecord(totalMs: number, dualStatus: 'matched' | 'mismatched', questionSha256 = QUESTION_A) {
  return sanitizeSemanticShadowRetainedObservation({
    ...common(questionSha256), terminal: 'semantic', observation: answerObservation(totalMs, dualStatus)
  } as unknown);
}

function operationalRecord() {
  return sanitizeSemanticShadowRetainedObservation({
    ...common(QUESTION_B, { ...PROVIDER, model_sha256: HASH('9') }),
    resolver_transaction_count: 0,
    resolver_transaction_counters: {
      statement_count: 0, returned_row_count: 0,
      statements: {
        driver_inventory_unscoped: 0, driver_inventory_scoped: 0,
        event_name: 0, event_round: 0
      }
    },
    terminal: 'operational_failure',
    failure: { reason: 'request_timeout', stage: 'proposal', total_ms: 30 },
    result_query_calls: 0
  } as unknown);
}

function supportsRetainedV2(): boolean {
  try {
    semanticRecord(10, 'matched');
    operationalRecord();
    return true;
  } catch {
    return false;
  }
}

describe('WP8 semantic shadow report', () => {
  it.skipIf(!supportsRetainedV2())('aggregates raw and Railway records without retaining raw content or question hashes', () => {
    const first = semanticRecord(10, 'matched');
    const second = semanticRecord(20, 'mismatched');
    const operational = operationalRecord();
    const content = [
      'DO_NOT_RETAIN unrelated line',
      JSON.stringify(first),
      JSON.stringify({ message: JSON.stringify(second), timestamp: '2026-07-30T12:00:01.000Z' }),
      JSON.stringify({ message: JSON.stringify(operational), timestamp: '2026-07-30T12:00:02.000Z' })
    ].join('\n');

    const report = buildSemanticShadowReportFromJsonl(content);
    expect(report.attempts).toEqual({ total: 3, semantic: 2, operational_failure: 1 });
    expect(report.semantic).toEqual({
      outcomes: { answer: 2 }, reasons: { plan_proven: 2 },
      topologies: { single_source_rows: 2 }, sources: { driver_standings: 2 },
      operators: { filter_project_sort_limit: 2 }, dual_statuses: { matched: 1, mismatched: 1 }
    });
    expect(report.operational).toEqual({ reasons: { request_timeout: 1 }, stages: { proposal: 1 } });
    expect(report.candidates).toEqual({ matched: 2, omitted: 0, extraneous: 0 });
    expect(report.resolver_totals).toEqual({
      transactions: 2, statements: 2, returned_rows: 4, inventory_reads: 2,
      event_reads: 0, inventory_entities: 4, verified_candidates: 6
    });
    expect(report.fingerprint_totals).toEqual({ reads: 0 });
    expect(report.provider_identity).toEqual({ distinct: 2, consistent: false });
    expect(report.repetition).toEqual({
      expected_question_groups: 41, expected_repetitions_per_group: 3, expected_attempts: 123,
      question_groups: 2, repeated_groups: 1, complete_groups: 0, incomplete_groups: 2,
      overfull_groups: 0, stable_groups: 0, drifted_groups: 1, status: 'fail'
    });
    expect(report.latency_ms).toEqual({
      semantic_total: { attempts: 2, p50_ms: 10, p95_ms: 20, max_ms: 20 },
      operational_total: { attempts: 1, p50_ms: 30, p95_ms: 30, max_ms: 30 }
    });
    expect(report.safety).toMatchObject({
      result_query_calls_zero: true, counter_parse_failures: 0, counters_valid: true,
      dual_mismatches: 1, dual_mismatches_zero: false,
      provider_identity_consistent: false, status: 'fail'
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('DO_NOT_RETAIN');
    expect(serialized).not.toContain(QUESTION_A);
    expect(serialized).not.toContain(QUESTION_B);
    expect(serialized).not.toContain(PROVIDER.model_sha256);
  });

  it.skipIf(!supportsRetainedV2())('requires all 41 question groups with exactly three stable semantic repetitions', () => {
    const corpusSha256 = HASH('c');
    const runSha256 = HASH('d');
    const questionHashes = Array.from({ length: 41 }, (_, index) =>
      createHash('sha256').update(`reviewed-question-${index}`).digest('hex'));
    const requirements: SemanticShadowReportRequirements = {
      corpus_sha256: corpusSha256,
      cases: questionHashes.map(questionSha256 => ({
        question_sha256: questionSha256,
        outcome: 'answer',
        reason: 'plan_proven',
        topology_code: 'single_source_rows',
        source_set_code: 'driver_standings'
      }))
    };
    const records = questionHashes.flatMap((questionSha256, caseIndex) =>
      Array.from({ length: 3 }, (_, repetitionIndex) => {
        const binding = { corpus_sha256: corpusSha256, run_sha256: runSha256, question_sha256: questionSha256, case_index: caseIndex, repetition_index: repetitionIndex };
        return sanitizeSemanticShadowRetainedObservation({
          ...common(questionSha256),
          evidence_binding: {
            corpus_sha256: corpusSha256,
            run_sha256: runSha256,
            case_index: caseIndex,
            repetition_index: repetitionIndex,
            attempt_sha256: computeSemanticShadowAttemptSha256(binding)
          },
          terminal: 'semantic',
          observation: answerObservation(10, 'matched')
        });
      }));
    const report = buildSemanticShadowReport(records, requirements);
    expect(report.repetition).toEqual({
      expected_question_groups: 41, expected_repetitions_per_group: 3, expected_attempts: 123,
      question_groups: 41, repeated_groups: 41, complete_groups: 41, incomplete_groups: 0,
      overfull_groups: 0, stable_groups: 41, drifted_groups: 0, status: 'pass'
    });
    expect(report.provider_identity).toEqual({ distinct: 1, consistent: true });
    expect(report.safety).toMatchObject({
      operational_failures_zero: true,
      evidence_binding_valid: true,
      oracle_exact: true,
      repetition_complete: true,
      repetition_stable: true,
      status: 'pass'
    });
    const outOfRangeBinding = {
      corpus_sha256: corpusSha256,
      run_sha256: runSha256,
      question_sha256: questionHashes[0],
      case_index: 41,
      repetition_index: 0
    };
    expect(() => sanitizeSemanticShadowRetainedObservation({
      ...common(questionHashes[0]),
      evidence_binding: {
        corpus_sha256: corpusSha256,
        run_sha256: runSha256,
        case_index: 41,
        repetition_index: 0,
        attempt_sha256: computeSemanticShadowAttemptSha256(outOfRangeBinding)
      },
      terminal: 'semantic',
      observation: answerObservation(10, 'matched')
    })).toThrow();

    const duplicated = [...records];
    duplicated[duplicated.length - 1] = duplicated[duplicated.length - 2];
    const duplicateReport = buildSemanticShadowReport(duplicated, requirements);
    expect(duplicateReport.evidence_binding).toMatchObject({ valid: false, failures: 1 });
    expect(duplicateReport.repetition.status).toBe('fail');
    expect(duplicateReport.safety.status).toBe('fail');

    const wrongOracle: SemanticShadowReportRequirements = {
      ...requirements,
      cases: requirements.cases.map((item, index) => index === 0 ? { ...item, reason: 'unsupported_scope' } : item)
    };
    expect(buildSemanticShadowReport(records, wrongOracle).oracle).toMatchObject({
      mismatched_attempts: 3,
      status: 'fail'
    });
  });

  it.skipIf(!supportsRetainedV2())('detects resolver-accounting drift and accepts a started operational transaction with no resolver statement', () => {
    const original = semanticRecord(10, 'matched');
    const changedCounters = sanitizeSemanticShadowRetainedObservation({
      ...original,
      resolver_transaction_counters: {
        ...original.resolver_transaction_counters,
        returned_row_count: original.resolver_transaction_counters.returned_row_count + 1
      }
    });
    const drift = buildSemanticShadowReport([original, changedCounters]);
    expect(drift.repetition).toMatchObject({ drifted_groups: 1, status: 'fail' });
    expect(drift.safety).toMatchObject({ repetition_stable: false, status: 'fail' });

    const operational = sanitizeSemanticShadowRetainedObservation({
      ...operationalRecord(),
      resolver_transaction_count: 1
    });
    const operationalReport = buildSemanticShadowReport([operational]);
    expect(operationalReport.resolver_totals).toMatchObject({ transactions: 1, statements: 0 });
    expect(operationalReport.safety).toMatchObject({
      counter_parse_failures: 0,
      counters_valid: true,
      operational_failures_zero: false,
      status: 'fail'
    });
    expect(() => sanitizeSemanticShadowRetainedObservation({
      ...operational,
      resolver_transaction_counters: {
        ...operational.resolver_transaction_counters,
        returned_row_count: 1
      }
    })).toThrow();
    expect(() => sanitizeSemanticShadowRetainedObservation({
      ...semanticRecord(10, 'matched'),
      resolver_transaction_counters: {
        statement_count: 1,
        returned_row_count: 10_002,
        statements: {
          driver_inventory_unscoped: 0,
          driver_inventory_scoped: 1,
          event_name: 0,
          event_round: 0
        }
      }
    })).toThrow();
  });

  it('ignores unrelated lines and pre-v2 output constructed through the real sanitizer', () => {
    const v2Input = { ...common(QUESTION_A), terminal: 'semantic', observation: answerObservation(10, 'matched') };
    const legacy = Object.fromEntries(Object.entries(v2Input)
      .filter(([key]) => key !== 'question_sha256' && key !== 'terminal'));
    const emittedV1 = sanitizeSemanticShadowRetainedObservation({
      ...legacy, version: 'semantic-shadow-retained-v1'
    });
    const report = buildSemanticShadowReportFromJsonl([
      JSON.stringify(emittedV1),
      JSON.stringify({ message: 'ordinary Railway output', timestamp: '2026-07-30T12:00:00.000Z' }),
      'not json'
    ].join('\n'));
    expect(report.attempts.total).toBe(0);
    expect(report.repetition.status).toBe('insufficient');
    expect(report.safety.status).toBe('insufficient');
  });

  it('rejects malformed lines that claim the retained v2 marker', () => {
    expect(() => buildSemanticShadowReportFromJsonl('{"version":"semantic-shadow-retained-v2"'))
      .toThrow('claim_malformed');
    expect(() => buildSemanticShadowReportFromJsonl(JSON.stringify({
      message: '{"version":"semantic-shadow-retained-v2"'
    }))).toThrow('claim_malformed');
    expect(() => buildSemanticShadowReportFromJsonl(JSON.stringify({
      version: 'semantic-shadow-retained-v2', terminal: 'semantic'
    }))).toThrow('claim_invalid');
    expect(() => buildSemanticShadowReportFromJsonl('{"version":"semantic-shadow-retained-v\\u0032"'))
      .toThrow('claim_malformed');
    expect(() => buildSemanticShadowReportFromJsonl(JSON.stringify({ version: 'semantic-shadow-retained-v20' })))
      .toThrow('claim_malformed');
    expect(() => buildSemanticShadowReportFromJsonl(
      '{"version":"semantic-shadow-retained-v2","version":"semantic-shadow-retained-v1"}'
    )).toThrow('claim_malformed');
    const valid = JSON.stringify(semanticRecord(10, 'matched'));
    const duplicateQuestion = valid.replace(
      `"question_sha256":"${QUESTION_A}"`,
      `"question_sha256":"SENSITIVE_RAW_QUESTION","question_sha256":"${QUESTION_A}"`
    );
    expect(() => buildSemanticShadowReportFromJsonl(duplicateQuestion)).toThrow('claim_malformed');
    expect(() => buildSemanticShadowReportFromJsonl(JSON.stringify({ message: duplicateQuestion })))
      .toThrow('claim_malformed');
  });

  it('derives complete reviewed candidate, work, dual, and pre/post-provider oracle fields', () => {
    const requirements = reviewedSemanticShadowReportRequirements(JSON.parse(
      readFileSync('tests/fixtures/compositional-regression.snapshot.json', 'utf8')
    ));
    expect(requirements.cases).toHaveLength(41);
    expect(requirements.cases.every(item => item.candidate_counts && item.template_dual_status)).toBe(true);
    expect(requirements.cases.filter(item => item.outcome === 'answer').every(item =>
      item.plan_work && item.operator_set_code && item.hashes?.semantic_proof_sha256)).toBe(true);
    const substitution = requirements.cases.find(item => item.reason === 'provider_candidate_not_enumerated')!;
    expect(substitution.provider_raw_candidate_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(substitution.hashes?.provider_candidate_set_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(substitution.hashes?.provider_candidate_set_sha256)
      .not.toBe(substitution.provider_raw_candidate_set_sha256);
  });

  it('bounded-reads one regular file and exposes only a closed command error', () => {
    const directory = mkdtempSync(join(tmpdir(), 'semantic-shadow-report-'));
    try {
      const validPath = join(directory, 'logs.jsonl');
      writeFileSync(validPath, '{"message":"unrelated","timestamp":"2026-07-30T12:00:00.000Z"}\n');
      expect(reportSemanticShadowFile(validPath).attempts.total).toBe(0);
      expect(() => reportSemanticShadowFile(directory)).toThrow('not_regular_file');
      const success = spawnSync('npx', ['tsx', 'scripts/report-semantic-shadow.ts', validPath], {
        cwd: process.cwd(), encoding: 'utf8'
      });
      expect(success.status).toBe(2);
      expect(success.stdout.endsWith('\n')).toBe(true);
      expect(success.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(success.stdout)).toMatchObject({
        version: 'semantic-shadow-report-v1', attempts: { total: 0 }
      });

      const oversizedPath = join(directory, 'oversized.jsonl');
      writeFileSync(oversizedPath, Buffer.alloc(2_000_001, 0x20));
      expect(() => reportSemanticShadowFile(oversizedPath)).toThrow('size_invalid');

      const invalidPath = join(directory, 'invalid.jsonl');
      writeFileSync(invalidPath, '{"version":"semantic-shadow-retained-v2"');
      const command = spawnSync('npx', ['tsx', 'scripts/report-semantic-shadow.ts', invalidPath], {
        cwd: process.cwd(), encoding: 'utf8'
      });
      expect(command.status).toBe(1);
      expect(command.stdout).toBe('{"status":"refused","error":"semantic_shadow_report_invalid"}\n');
      expect(command.stderr).toBe('');

      const source = readFileSync('src/f1ql/semantic-shadow-report.ts', 'utf8');
      const script = readFileSync('scripts/report-semantic-shadow.ts', 'utf8');
      expect(source).not.toContain('executeF1QL');
      expect(source).not.toMatch(/from ['"].*executor/u);
      expect(script).not.toContain('console.log');
      expect(script).toContain('2_000_000');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
