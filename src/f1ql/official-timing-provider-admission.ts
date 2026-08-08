import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OfficialTimingQuestionMatch } from './official-timing-question';

export const OFFICIAL_TIMING_PROVIDER_ADMISSION_VERSION = 'official-timing-provider-admission-v1' as const;

// Mirrors the sealed provider schema v2 variant: strict closed properties, span refs carry
// offsets only (text is proven by offset equality against the normalized question), and
// lap-range evidence is required for window median and forbidden (null) for event mean.
const wireSpanSchema = z.object({
  start: z.number().int().min(0).max(1_000),
  end: z.number().int().positive().max(1_000)
}).strict().refine(span => span.end > span.start, 'span end must be after start');
const wireEvidenceSchema = z.array(wireSpanSchema).min(1).max(8);
export const officialTimingProviderProposalSchema = z.object({
  operation: z.literal('certified_official_timing_compare'),
  driver_a_span: wireSpanSchema,
  driver_b_span: wireSpanSchema,
  event_span: wireSpanSchema,
  operation_evidence: wireEvidenceSchema,
  season_evidence: wireEvidenceSchema,
  lap_range_evidence: z.union([
    z.null(),
    z.object({ start_span: wireSpanSchema, end_span: wireSpanSchema }).strict()
  ])
}).strict();

export type OfficialTimingProviderProposal = z.infer<typeof officialTimingProviderProposalSchema>;

export type OfficialTimingProviderAdmission =
  | { readonly type: 'admitted'; readonly provider_candidate_set_sha256: string }
  | { readonly type: 'malformed' }
  | { readonly type: 'drifted'; readonly provider_candidate_set_sha256: string };

export function admitOfficialTimingProviderProposal(
  input: unknown,
  question: OfficialTimingQuestionMatch
): OfficialTimingProviderAdmission {
  let proposal: OfficialTimingProviderProposal;
  try {
    proposal = officialTimingProviderProposalSchema.parse(input);
  } catch {
    return { type: 'malformed' };
  }
  const providerHash = hashValue(proposal);
  if (!proposalSpansMatch(proposal, question)) {
    return { type: 'drifted', provider_candidate_set_sha256: providerHash };
  }
  return { type: 'admitted', provider_candidate_set_sha256: providerHash };
}

function proposalSpansMatch(
  proposal: OfficialTimingProviderProposal,
  question: OfficialTimingQuestionMatch
): boolean {
  const spanMatch = (actual: { start: number; end: number }, expected: { start: number; end: number }) =>
    actual.start === expected.start && actual.end === expected.end;
  const coreMatch =
    spanMatch(proposal.driver_a_span, question.driver_a) &&
    spanMatch(proposal.driver_b_span, question.driver_b) &&
    spanMatch(proposal.event_span, question.event_span) &&
    proposal.operation_evidence.length === 1 && spanMatch(proposal.operation_evidence[0], question.operation_span) &&
    proposal.season_evidence.length === 1 && spanMatch(proposal.season_evidence[0], question.season_span);
  if (!coreMatch) {
    return false;
  }
  if (question.lap_range === null) {
    return proposal.lap_range_evidence === null;
  }
  const lapEvidence = proposal.lap_range_evidence;
  return lapEvidence !== null &&
    spanMatch(lapEvidence.start_span, question.lap_range.start_span) &&
    spanMatch(lapEvidence.end_span, question.lap_range.end_span);
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
