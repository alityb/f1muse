import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { goldenRegistry as registry } from './golden-registry';

describe('golden incident registry', () => {
  it('contains uniquely identified regression cases', () => {
    const ids = registry.cases.map((golden) => golden.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records both answer and refusal correctness cases', () => {
    expect(registry.cases.some((golden) => golden.outcome === 'answer')).toBe(true);
    expect(registry.cases.some((golden) => golden.outcome === 'refusal')).toBe(true);
  });

  it('requires an authority, assertion, and evidence record for every regression', () => {
    for (const golden of registry.cases) {
      expect(golden.authority).not.toHaveLength(0);
      expect(golden.assertions.length).toBeGreaterThan(0);
      expect(golden.evidence.reference).not.toHaveLength(0);
    }
  });

  it('requires a query only for API golden cases', () => {
    for (const golden of registry.cases) {
      if (golden.target === 'api') {
        expect(golden.query).toBeTruthy();
      } else {
        expect(golden.query).toBeUndefined();
      }
    }
  });

  it('does not promote unsupported observations to verified goldens', () => {
    for (const golden of registry.cases.filter((golden) => golden.status === 'verified')) {
      expect(golden.evidence.independently_verified).toBe(true);
      expect(golden.evidence.snapshot).toBeTruthy();
      expect(existsSync(resolve(process.cwd(), golden.evidence.snapshot!))).toBe(true);
    }
  });
});
