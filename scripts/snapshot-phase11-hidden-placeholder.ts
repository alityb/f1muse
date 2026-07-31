import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalizeHiddenHoldoutJson,
  HIDDEN_HOLDOUT_CONTRACT_VERSION,
  HIDDEN_HOLDOUT_PAYLOAD_ENV,
  HIDDEN_HOLDOUT_SHA256_ENV
} from './run-phase11-hidden-holdout';

export const HIDDEN_HOLDOUT_METADATA_PATH = path.resolve(
  process.cwd(),
  'metadata/phase11-wp7-hidden-holdout.json'
);
export const HIDDEN_HOLDOUT_METADATA_EMITTER_VERSION = 'phase11-hidden-placeholder-emitter-v1' as const;

export function emitHiddenHoldoutMetadata(): string {
  const placeholder = canonicalizeHiddenHoldoutJson({
    schema_version: 1,
    contract_version: HIDDEN_HOLDOUT_CONTRACT_VERSION,
    cases: []
  });
  const metadata = {
    schema_version: 1,
    contract_version: HIDDEN_HOLDOUT_CONTRACT_VERSION,
    emitter: {
      version: HIDDEN_HOLDOUT_METADATA_EMITTER_VERSION,
      script: 'scripts/snapshot-phase11-hidden-placeholder.ts'
    },
    payload_environment_variable: HIDDEN_HOLDOUT_PAYLOAD_ENV,
    sha256_environment_variable: HIDDEN_HOLDOUT_SHA256_ENV,
    digest_contract: {
      algorithm: 'sha256',
      input: 'exact_base64_decoded_canonical_utf8_json_bytes',
      encoding: 'lowercase_hex',
      independently_supplied: true,
      active_provenance_required: true
    },
    committed_content: {
      case_count: 0,
      contains_questions: false,
      contains_entities: false,
      contains_plans_or_sql: false
    },
    zero_content_placeholder: {
      canonical_utf8_json: placeholder,
      sha256: sha256(placeholder),
      runtime_evaluable: false
    },
    runtime_contract: {
      minimum_case_count: 1,
      split: 'hidden_holdout',
      template_free_required: true,
      actual_structural_novelty_required: true,
      reviewed_capability_interaction_required: true,
      public_question_hash_overlap_allowed: false,
      public_plan_structure_overlap_allowed: false,
      current_supported_gate_status: 'blocked_until_a_supported_plan_structure_is_novel_against_the_public_compositional_corpus',
      database_execution_allowed: false,
      output_detail: 'hashes_counts_and_aggregate_outcomes_only'
    }
  };
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

if (require.main === module) {
  writeFileSync(HIDDEN_HOLDOUT_METADATA_PATH, emitHiddenHoldoutMetadata());
  process.stdout.write(`Wrote ${HIDDEN_HOLDOUT_METADATA_PATH}\n`);
}
