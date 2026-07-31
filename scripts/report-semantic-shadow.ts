import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  buildSemanticShadowReportFromJsonl,
  SemanticShadowReportRequirements
} from '../src/f1ql/semantic-shadow-report';
import {
  computeSemanticCandidateSetHash,
  computeSemanticEvidenceHash,
  enumerateSemanticQueries
} from '../src/f1ql/semantic-query';
import reviewedSnapshot from '../tests/fixtures/compositional-regression.snapshot.json';
import { compositionalRegressionCorpusInput } from '../tests/fixtures/compositional-regression-corpus';

const MAXIMUM_LOG_BYTES = 2_000_000;

export function reportSemanticShadowFile(path: string): ReturnType<typeof buildSemanticShadowReportFromJsonl> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let content: Buffer;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error('semantic_shadow_log_not_regular_file');
    }
    if (metadata.size < 1 || metadata.size > MAXIMUM_LOG_BYTES) {
      throw new Error('semantic_shadow_log_size_invalid');
    }
    content = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const bytesRead = readSync(descriptor, content, offset, metadata.size - offset, offset);
      if (bytesRead === 0) {
        throw new Error('semantic_shadow_log_read_incomplete');
      }
      offset += bytesRead;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, metadata.size) !== 0) {
      throw new Error('semantic_shadow_log_changed_during_read');
    }
  } finally {
    closeSync(descriptor);
  }
  return buildSemanticShadowReportFromJsonl(
    new TextDecoder('utf-8', { fatal: true }).decode(content),
    reviewedSemanticShadowReportRequirements(reviewedSnapshot)
  );
}

export function reviewedSemanticShadowReportRequirements(input: unknown): SemanticShadowReportRequirements {
  const snapshot = input as {
    corpus_hash?: unknown;
    cases?: Array<{
      question_sha256?: unknown;
      action?: unknown;
      reason?: unknown;
      entity_inventory?: unknown;
      evidence?: { candidate_count?: unknown; evidence_hash?: unknown; candidate_set_hash?: unknown };
      admission?: { query_hash?: unknown };
      plan?: {
        topology?: unknown; source_ids?: unknown; work?: unknown; answer_plan_hash?: unknown;
        planned_f1ql_hash?: unknown; core_hash?: unknown
      } | null;
      proof?: { proof_hash?: unknown; topology_hash?: unknown; compiled_hash?: unknown } | null;
    }>;
  };
  if (typeof snapshot.corpus_hash !== 'string' || !Array.isArray(snapshot.cases)) {
    throw new Error('semantic_shadow_reviewed_snapshot_invalid');
  }
  const corpus = compositionalRegressionCorpusInput as {
    cases?: Array<{ id?: unknown; provider_mode?: unknown; question?: unknown }>;
  };
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== snapshot.cases.length) {
    throw new Error('semantic_shadow_reviewed_snapshot_invalid');
  }
  const operators: Record<string, string> = {
    single_source_rows: 'filter_project_sort_limit',
    single_source_aggregate: 'filter_aggregate_project_sort_limit',
    row_dimension_join: 'filter_join_project_sort_limit',
    scalar_aggregate_compose: 'filter_aggregate_compose_project_sort_limit'
  };
  const matchedDualCases = new Set(['promoted-single-source-rows', 'holdout-single-source-rows']);
  const incompleteDualCases = new Set([
    'abstain-provider-substitution', 'abstain-unknown-language', 'abstain-unsupported-concept'
  ]);
  return {
    corpus_sha256: snapshot.corpus_hash,
    cases: snapshot.cases.map((item, index) => {
      const corpusCase = corpus.cases![index];
      if (typeof item.question_sha256 !== 'string' ||
          !['answer', 'clarify', 'abstain'].includes(item.action as string) || typeof item.reason !== 'string' ||
          !corpusCase || typeof corpusCase.id !== 'string' ||
          typeof corpusCase.question !== 'string' ||
          !['enumerated', 'omit_last_output'].includes(corpusCase.provider_mode as string) ||
          !Array.isArray(item.entity_inventory)) {
        throw new Error('semantic_shadow_reviewed_snapshot_invalid');
      }
      const evidence = enumerateSemanticQueries(corpusCase.question, item.entity_inventory as never);
      if (computeSemanticEvidenceHash(evidence) !== item.evidence?.evidence_hash ||
          (evidence.type === 'candidate_set' ? evidence.candidate_set_hash : null) !== item.evidence?.candidate_set_hash) {
        throw new Error('semantic_shadow_reviewed_snapshot_invalid');
      }
      const answer = item.action === 'answer';
      if (answer && (!item.plan || !item.proof || typeof item.evidence?.evidence_hash !== 'string' ||
          typeof item.evidence.candidate_set_hash !== 'string' || typeof item.admission?.query_hash !== 'string' ||
          typeof item.plan.topology !== 'string' || !Array.isArray(item.plan.source_ids) ||
          item.plan.source_ids.some(source => typeof source !== 'string') ||
          typeof item.plan.answer_plan_hash !== 'string' || typeof item.plan.planned_f1ql_hash !== 'string' ||
          typeof item.plan.core_hash !== 'string' || typeof item.proof.proof_hash !== 'string' ||
          typeof item.proof.topology_hash !== 'string' || typeof item.proof.compiled_hash !== 'string')) {
        throw new Error('semantic_shadow_reviewed_snapshot_invalid');
      }
      const candidateCount = evidence.type === 'candidate_set' ? evidence.candidates.length : 0;
      if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
        throw new Error('semantic_shadow_reviewed_snapshot_invalid');
      }
      const providerMode = corpusCase.provider_mode as 'enumerated' | 'omit_last_output';
      const candidateCounts = evidence.type === 'abstention' ? {
        enumerated: 0, proposed: 0, matched: 0, omitted: 0, extraneous: 0, comparison: 'not_comparable',
        ...(evidence.candidate_count_lower_bound === undefined ? {} : {
          enumerated_lower_bound: evidence.candidate_count_lower_bound
        })
      } : providerMode === 'omit_last_output' ? {
        enumerated: candidateCount, proposed: 1, matched: 0, omitted: 1, extraneous: 1, comparison: 'mixed'
      } : {
        enumerated: candidateCount, proposed: candidateCount, matched: candidateCount,
        omitted: 0, extraneous: 0, comparison: 'exact'
      };
      const hashes: Record<string, string> = {
        semantic_evidence_sha256: item.evidence!.evidence_hash as string
      };
      if (typeof item.evidence!.candidate_set_hash === 'string') {
        hashes.candidate_set_sha256 = item.evidence!.candidate_set_hash;
        const providerCandidates = providerMode === 'enumerated'
          ? evidence.type === 'candidate_set' ? evidence.candidates : []
          : mutatedProviderCandidates(evidence);
        hashes.provider_candidate_set_sha256 = computeSemanticCandidateSetHash(
          providerCandidates, evidence.question_sha256, evidence.catalog_hash
        );
      }
      if (answer) {
        Object.assign(hashes, {
          semantic_query_sha256: item.admission!.query_hash as string,
          answer_plan_sha256: item.plan!.answer_plan_hash as string,
          topology_sha256: item.proof!.topology_hash as string,
          planned_f1ql_sha256: item.plan!.planned_f1ql_hash as string,
          core_sha256: item.plan!.core_hash as string,
          compiled_sha256: item.proof!.compiled_hash as string,
          semantic_proof_sha256: item.proof!.proof_hash as string
        });
      }
      return {
        question_sha256: item.question_sha256,
        outcome: item.action as 'answer' | 'clarify' | 'abstain',
        reason: answer ? 'plan_proven' : item.reason,
        candidate_counts: candidateCounts,
        hashes,
        ...(evidence.type === 'candidate_set' ? {
          provider_raw_candidate_set_sha256: evidence.candidate_set_hash
        } : {}),
        template_dual_status: matchedDualCases.has(corpusCase.id) ? 'matched' :
          incompleteDualCases.has(corpusCase.id) ? 'semantic_lane_incomplete' : 'not_applicable',
        ...(answer ? {
          topology_code: item.plan!.topology as string,
          source_set_code: (item.plan!.source_ids as string[]).join('__'),
          operator_set_code: operators[item.plan!.topology as string],
          plan_work: item.plan!.work as unknown as Record<string, number | string>
        } : {})
      };
    })
  };
}

function mutatedProviderCandidates(evidence: ReturnType<typeof enumerateSemanticQueries>) {
  if (evidence.type !== 'candidate_set' || evidence.candidates.length !== 1 || evidence.candidates[0].outputs.length < 2) {
    throw new Error('semantic_shadow_reviewed_snapshot_invalid');
  }
  const candidate = structuredClone(evidence.candidates[0]);
  candidate.outputs.pop();
  return [candidate];
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('Usage: report-semantic-shadow <logs.jsonl>');
  }
  const report = reportSemanticShadowFile(args[0]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.safety.status !== 'pass' || report.repetition.status !== 'pass' || report.oracle.status !== 'pass') {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused","error":"semantic_shadow_report_invalid"}\n');
    process.exitCode = 1;
  }
}
