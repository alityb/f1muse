import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareNightlyVerificationArtifacts } from '../../scripts/prepare-nightly-verification-artifacts';

describe('nightly verification artifacts', () => {
  it('adds UTC and commit metadata while redacting URLs and credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'f1ql-nightly-artifacts-'));
    try {
      const golden = join(directory, 'golden.json');
      const authority = join(directory, 'authority.json');
      const pace = join(directory, 'pace.json');
      const performance = join(directory, 'performance.json');
      const shadow = join(directory, 'shadow.md');
      writeFileSync(golden, JSON.stringify({ status: 'passed', database_url: 'postgresql://user:password@db.example/f1' }));
      writeFileSync(authority, JSON.stringify({ status: 'passed', source_authority: [{ url: 'https://www.fia.com/document' }] }));
      writeFileSync(pace, JSON.stringify({ status: 'ready' }));
      writeFileSync(performance, JSON.stringify({ status: 'observed', database_url: 'postgresql://user:password@db.example/f1' }));
      writeFileSync(shadow, '# Report\nhttps://railway.example/log\n');

      prepareNightlyVerificationArtifacts({ commit: 'abc123', output: join(directory, 'out'), golden, authority, pace, performance, shadow }, '2026-07-23T00:00:00.000Z');

      const metadata = readFileSync(join(directory, 'out', 'verification-metadata.json'), 'utf8');
      const authorityReport = readFileSync(join(directory, 'out', 'database-authority-audit.json'), 'utf8');
      const shadowReport = readFileSync(join(directory, 'out', 'f1ql-shadow-review.md'), 'utf8');
      expect(metadata).toContain('2026-07-23T00:00:00.000Z');
      expect(metadata).toContain('abc123');
      expect(authorityReport).not.toContain('fia.com');
      expect(authorityReport).toContain('[redacted-url]');
      expect(shadowReport).not.toContain('railway.example');
      expect(readFileSync(join(directory, 'out', 'production-golden.json'), 'utf8')).not.toContain('password');
      expect(readFileSync(join(directory, 'out', 'f1ql-performance-evidence.json'), 'utf8')).not.toContain('password');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
