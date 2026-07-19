import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('F1QL shadow report', () => {
  it('parses raw and Railway JSON log lines with exact outcome counts', () => {
    const output = execFileSync('npx', ['tsx', 'scripts/report-f1ql-shadow.ts', 'tests/fixtures/f1ql-shadow.log'], { encoding: 'utf8' });
    expect(output).toContain('- Attempts: 5');
    expect(output).toContain('- succeeded: 1');
    expect(output).toContain('- invalid: 1');
    expect(output).toContain('- identity_miss: 1');
    expect(output).toContain('- unavailable: 1');
    expect(output).toContain('- program_invalid: 1');
    expect(output).toContain('2026-07-01T00:00:00.000Z to 2026-07-05T00:00:00.000Z');
  });
});
