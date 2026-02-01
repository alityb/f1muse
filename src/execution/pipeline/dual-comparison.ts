import { QueryIntent } from '../../types/query-intent';
import {
  QueryError,
  TeammateGapDualComparisonPayload,
  DualComparisonMetricComponent
} from '../../types/results';
import {
  AnalyticalResponse,
  CoverageStatus,
  ErrorCode,
  buildConfidence
} from '../../types/api-response';
import { COVERAGE_STATUS_COPY } from '../../config/teammate-gap';
import { ResponseBuilder, buildErrorResponse, getSuggestionsForError, mapReasonToErrorCode } from '../response-builder';

type DualComparisonIntent = Extract<QueryIntent, { kind: 'teammate_gap_dual_comparison' }>;

export function buildDualComparisonResponseFromPayload(
  intent: DualComparisonIntent,
  payload: TeammateGapDualComparisonPayload,
  debug?: AnalyticalResponse<TeammateGapDualComparisonPayload>['debug']
): AnalyticalResponse<TeammateGapDualComparisonPayload> {
  const input = {
    season: intent.season,
    driver_a_id: intent.driver_a_id,
    driver_b_id: intent.driver_b_id,
    team_id: intent.team_id ?? null
  };
  const metricId = 'teammate_gap_comparison_dual';

  const coverage = combineDualCoverage(payload.qualifying, payload.race_pace);
  const actualSampleSize = computeMinSampleSize(payload);
  const confidenceReason = buildConfidenceReason(payload);
  const confidence = buildConfidence(coverage, actualSampleSize, confidenceReason);

  confidence.reasons = buildDualComparisonConfidenceReasons(payload);
  confidence.shared_events = actualSampleSize;

  const warnings = buildDualComparisonWarnings(payload);

  return new ResponseBuilder<TeammateGapDualComparisonPayload>(intent.kind)
    .setInput(input)
    .setResult(payload)
    .setConfidence(confidence)
    .setMethodologyFromMetric(metricId)
    .addWarnings(warnings)
    .setDebug(debug)
    .build();
}

export function buildDualComparisonErrorResponse(
  intent: DualComparisonIntent,
  error: QueryError,
  debug?: AnalyticalResponse<TeammateGapDualComparisonPayload>['debug']
): AnalyticalResponse<TeammateGapDualComparisonPayload> {
  const input = {
    season: intent.season,
    driver_a_id: intent.driver_a_id,
    driver_b_id: intent.driver_b_id,
    team_id: intent.team_id ?? null
  };
  const metricId = 'teammate_gap_comparison_dual';
  const mapped = mapDualComparisonError(error);

  return buildErrorResponse<TeammateGapDualComparisonPayload>(
    intent.kind,
    input,
    mapped.code,
    mapped.message,
    mapped.suggestions,
    metricId,
    debug
  );
}

function combineDualCoverage(
  qualifying: DualComparisonMetricComponent,
  race: DualComparisonMetricComponent
): CoverageStatus {
  if (qualifying.available && race.available) {
    if (qualifying.coverage_status === 'valid' && race.coverage_status === 'valid') {
      return 'valid';
    }
    if (qualifying.coverage_status === 'insufficient' || race.coverage_status === 'insufficient') {
      return 'insufficient';
    }
    return 'low_coverage';
  }

  if (qualifying.available) {
    return qualifying.coverage_status;
  }
  if (race.available) {
    return race.coverage_status;
  }

  return 'insufficient';
}

function computeMinSampleSize(payload: TeammateGapDualComparisonPayload): number {
  const qualifyingRaces = payload.qualifying.available ? payload.qualifying.shared_races : Infinity;
  const raceRaces = payload.race_pace.available ? payload.race_pace.shared_races : Infinity;
  const minSampleSize = Math.min(qualifyingRaces, raceRaces);
  return minSampleSize === Infinity ? 0 : minSampleSize;
}

function buildConfidenceReason(payload: TeammateGapDualComparisonPayload): string {
  const availableCount = Number(payload.qualifying.available) + Number(payload.race_pace.available);

  if (availableCount < 2) {
    return `Based on ${availableCount} of 2 metrics`;
  }

  return `Based on qualifying (${payload.qualifying.shared_races} races) and race pace (${payload.race_pace.shared_races} races)`;
}

function buildDualComparisonWarnings(payload: TeammateGapDualComparisonPayload): string[] {
  const warnings: string[] = [];

  const qualifyingAvailable = payload.qualifying.available;
  const raceAvailable = payload.race_pace.available;

  if (!qualifyingAvailable || !raceAvailable) {
    warnings.push('Partial result: some metrics unavailable');
    if (!qualifyingAvailable) {
      warnings.push('qualifying: unavailable (insufficient coverage or no data)');
    }
    if (!raceAvailable) {
      warnings.push('race_pace: unavailable (insufficient coverage or no data)');
    }
  }

  const qualifyingLowCoverage = payload.qualifying.coverage_status === 'low_coverage';
  const raceLowCoverage = payload.race_pace.coverage_status === 'low_coverage';
  const lowCoverageCopy = COVERAGE_STATUS_COPY.low_coverage;

  if (lowCoverageCopy) {
    if (qualifyingAvailable && qualifyingLowCoverage) {
      warnings.push(`qualifying: ${lowCoverageCopy}`);
    }
    if (raceAvailable && raceLowCoverage) {
      warnings.push(`race_pace: ${lowCoverageCopy}`);
    }
  }

  return warnings;
}

function buildDualComparisonConfidenceReasons(payload: TeammateGapDualComparisonPayload): string[] {
  const reasons: string[] = [];

  if (payload.qualifying.available && payload.race_pace.available) {
    reasons.push('Both qualifying and race pace metrics available');
  } else if (payload.qualifying.available) {
    reasons.push('Only qualifying metric available');
  } else if (payload.race_pace.available) {
    reasons.push('Only race pace metric available');
  } else {
    reasons.push('Neither metric available');
  }

  if (payload.qualifying.available) {
    const qualStatus = payload.qualifying.coverage_status;
    reasons.push(`Qualifying coverage: ${qualStatus} (${payload.qualifying.shared_races} shared races)`);
  }
  if (payload.race_pace.available) {
    const raceStatus = payload.race_pace.coverage_status;
    reasons.push(`Race pace coverage: ${raceStatus} (${payload.race_pace.shared_races} shared races)`);
  }

  if (payload.qualifying.available && payload.race_pace.available) {
    const minRaces = Math.min(payload.qualifying.shared_races, payload.race_pace.shared_races);
    reasons.push(`Confidence based on MIN coverage: ${minRaces} shared races`);
  }

  if (payload.overall_summary.same_winner !== null) {
    if (payload.overall_summary.same_winner) {
      reasons.push('Same driver faster in both metrics (consistent advantage)');
    } else {
      reasons.push('Different drivers faster in each metric (split advantage)');
    }
  }

  return reasons;
}

function mapDualComparisonError(error: QueryError): {
  code: ErrorCode;
  message: string;
  suggestions: string[];
} {
  const reason = error.reason || 'Unknown error';
  const normalized = reason.toLowerCase();

  let code: ErrorCode;
  if (normalized.includes('not teammates') || normalized.includes('not_teammates')) {
    code = 'NOT_TEAMMATES';
  } else if (normalized.includes('driver_not_in_season') || normalized.includes('driver missing')) {
    code = 'NO_DATA';
  } else if (normalized.includes('no data found')) {
    code = 'NO_DATA';
  } else if (normalized.includes('no data available for either')) {
    code = 'INSUFFICIENT_COVERAGE';
  } else if (normalized.includes('insufficient') || normalized.includes('coverage')) {
    code = 'INSUFFICIENT_COVERAGE';
  } else {
    code = mapReasonToErrorCode(reason);
  }

  return {
    code,
    message: reason,
    suggestions: getSuggestionsForError(code)
  };
}
