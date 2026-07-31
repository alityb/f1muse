import { createHash } from 'crypto';
import { F1QLProgram } from './ast';
import { parseF1QLProgram } from './schema';

function normalizeValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeValue(item));
    if (key === 'classification_status' || key === 'rounds' || key === 'season' || key === 'driver_id') {
      return [...normalized].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
    }
    return normalized;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([childKey, item]) => [childKey, normalizeValue(item, childKey)]));
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

export function normalizeF1QLProgram(input: unknown): F1QLProgram {
  return normalizeValue(parseF1QLProgram(input)) as F1QLProgram;
}

export function getF1QLProgramHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeF1QLProgram(input))).digest('hex');
}
