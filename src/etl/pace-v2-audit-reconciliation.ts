import { createHash } from 'crypto';

export const PACE_V2_AUDIT_RECONCILIATION_VERSION = 1;
export const PACE_V2_AUDIT_RECONCILIATION_METHOD = 'manifest_fact_fingerprint_only_v1';
export const PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION = 'clean_air_gap_2_0s_v1';

export interface PaceV2AuditReconciliationManifest {
  version: number;
  reconciliation: 'pace_v2_manifest_fact_fingerprint_only';
  season: number;
  round: number;
  session_type: 'R';
  methodology_version: string;
  fact_row_count: number;
  original_manifest_fact_fingerprint: string;
  current_fact_fingerprint: string;
  manifest_fingerprint: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createPaceV2AuditReconciliationManifest(
  contract: Omit<PaceV2AuditReconciliationManifest, 'version' | 'reconciliation' | 'manifest_fingerprint'>
): PaceV2AuditReconciliationManifest {
  const stable = {
    version: PACE_V2_AUDIT_RECONCILIATION_VERSION,
    reconciliation: 'pace_v2_manifest_fact_fingerprint_only' as const,
    ...contract
  };
  return { ...stable, manifest_fingerprint: sha256(JSON.stringify(stable)) };
}

export function parsePaceV2AuditReconciliationManifest(input: unknown): PaceV2AuditReconciliationManifest {
  if (!input || typeof input !== 'object') {
    throw new Error('FAIL_CLOSED: reconciliation manifest must be an object');
  }
  const manifest = input as Partial<PaceV2AuditReconciliationManifest>;
  if (
    manifest.version !== PACE_V2_AUDIT_RECONCILIATION_VERSION ||
    manifest.reconciliation !== 'pace_v2_manifest_fact_fingerprint_only' ||
    !Number.isInteger(manifest.season) || !Number.isInteger(manifest.round) || (manifest.round ?? 0) < 1 ||
    manifest.session_type !== 'R' || manifest.methodology_version !== PACE_V2_AUDIT_RECONCILIATION_METHODOLOGY_VERSION ||
    !Number.isInteger(manifest.fact_row_count) || (manifest.fact_row_count ?? 0) < 1 ||
    !/^[a-f0-9]{64}$/.test(manifest.original_manifest_fact_fingerprint ?? '') ||
    !/^[a-f0-9]{64}$/.test(manifest.current_fact_fingerprint ?? '') ||
    !/^[a-f0-9]{64}$/.test(manifest.manifest_fingerprint ?? '')
  ) {
    throw new Error('FAIL_CLOSED: reconciliation manifest has an unsupported shape');
  }
  if (manifest.original_manifest_fact_fingerprint === manifest.current_fact_fingerprint) {
    throw new Error('FAIL_CLOSED: reconciliation requires a manifest fact fingerprint mismatch');
  }
  const validated = manifest as PaceV2AuditReconciliationManifest;
  const expected = createPaceV2AuditReconciliationManifest({
    season: validated.season, round: validated.round, session_type: validated.session_type,
    methodology_version: validated.methodology_version, fact_row_count: validated.fact_row_count,
    original_manifest_fact_fingerprint: validated.original_manifest_fact_fingerprint,
    current_fact_fingerprint: validated.current_fact_fingerprint
  });
  if (expected.manifest_fingerprint !== validated.manifest_fingerprint) {
    throw new Error('FAIL_CLOSED: reconciliation manifest fingerprint does not match its contract');
  }
  return validated;
}
