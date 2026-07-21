export const RETIREMENT_REASON_CATEGORIES = [
  'accident',
  'collision',
  'engine',
  'gearbox',
  'transmission',
  'hydraulics',
  'brakes',
  'suspension',
  'electrical',
  'puncture',
  'tyre',
  'mechanical',
  'overheating',
  'fuel_system',
  'oil_system',
  'drivetrain',
  'wheel',
  'unknown'
] as const;

export type RetirementReasonCategory = (typeof RETIREMENT_REASON_CATEGORIES)[number];

function normalizeReasonKey(reason: string): string {
  return reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const RETIREMENT_REASON_MAP: ReadonlyMap<string, RetirementReasonCategory> = new Map([
  ['accident', 'accident'],
  ['collision', 'collision'],
  ['engine', 'engine'],
  ['engine failure', 'engine'],
  ['gearbox', 'gearbox'],
  ['transmission', 'transmission'],
  ['hydraulics', 'hydraulics'],
  ['brakes', 'brakes'],
  ['suspension', 'suspension'],
  ['electrical', 'electrical'],
  ['electronics', 'electrical'],
  ['puncture', 'puncture'],
  ['tyre', 'tyre'],
  ['tire', 'tyre'],
  ['mechanical', 'mechanical'],
  ['overheating', 'overheating'],
  ['fuel system', 'fuel_system'],
  ['fuel pressure', 'fuel_system'],
  ['fuel pump', 'fuel_system'],
  ['oil leak', 'oil_system'],
  ['oil pressure', 'oil_system'],
  ['drive shaft', 'drivetrain'],
  ['drivetrain', 'drivetrain'],
  ['wheel', 'wheel'],
  ['wheel nut', 'wheel']
]);

/**
 * Map only known source labels; unrecognized or absent labels stay explicit.
 */
export function normalizeRetirementReason(reason: string | null | undefined): RetirementReasonCategory {
  if (!reason) {
    return 'unknown';
  }

  return RETIREMENT_REASON_MAP.get(normalizeReasonKey(reason)) ?? 'unknown';
}
