import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  computeOfficialTimingQueryHash,
  OfficialTimingSemanticEvidence
} from './official-timing-semantic-query';

export const OFFICIAL_TIMING_PROVIDER_ADMISSION_VERSION = 'official-timing-provider-admission-v2' as const;
export const OFFICIAL_TIMING_PROVIDER_SELECTION_VERSION = 2 as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

// The provider has no semantic composition authority. The server owns the full
// canonical candidate and exposes only its opaque digest as the selectable ID.
export const officialTimingProviderSelectionSchema = z.object({
  version: z.literal(OFFICIAL_TIMING_PROVIDER_SELECTION_VERSION),
  candidate_id: sha256Schema
}).strict();

export type OfficialTimingProviderSelection = z.infer<typeof officialTimingProviderSelectionSchema>;

export type OfficialTimingProviderAdmission =
  | { readonly type: 'admitted'; readonly provider_candidate_set_sha256: string }
  | { readonly type: 'malformed' }
  | { readonly type: 'drifted'; readonly provider_candidate_set_sha256: string };

export function admitOfficialTimingProviderSelection(
  input: unknown,
  evidence: OfficialTimingSemanticEvidence
): OfficialTimingProviderAdmission {
  let selection: OfficialTimingProviderSelection;
  try {
    selection = officialTimingProviderSelectionSchema.parse(input);
  } catch {
    return { type: 'malformed' };
  }
  const providerHash = hashValue(selection);
  const expectedCandidateId = computeOfficialTimingQueryHash(evidence.candidates[0]);
  if (selection.candidate_id !== expectedCandidateId) {
    return { type: 'drifted', provider_candidate_set_sha256: providerHash };
  }
  return { type: 'admitted', provider_candidate_set_sha256: providerHash };
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareText).map(key =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('FAIL_CLOSED: official timing provider value is not canonically serializable');
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}
