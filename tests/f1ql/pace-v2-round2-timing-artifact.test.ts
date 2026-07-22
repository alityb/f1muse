import { createHash } from 'crypto';
import { mkdtempSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ROUND_2_FIA_FINAL_CLASSIFICATION_URL, fetchRound2TimingArtifact, inspectFiaFinalClassificationText, validateRound2TimingArtifactUrl, writeRound2TimingArtifact } from '../../scripts/fetch-pace-v2-round2-timing-artifact';

describe('round-2 FIA timing artifact', () => {
  it('fetches only the reviewed FIA PDF and preserves it with a content hash', async () => {
    const content = Buffer.from('%PDF-1.7\nfixture');
    const artifact = await fetchRound2TimingArtifact(async (url) => ({ ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) }), () => new Date('2026-07-21T00:00:00.000Z'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pace-v2-round2-test-'));
    try {
      const report = writeRound2TimingArtifact(artifact, 'Alexander Albon Gabriel Bortoleto Lando Norris Oscar Piastri', directory);
      expect(report.source_url).toBe(ROUND_2_FIA_FINAL_CLASSIFICATION_URL);
      expect(report.artifact_sha256).toBe(createHash('sha256').update(content).digest('hex'));
      expect(statSync(report.output).mode & 0o777).toBe(0o600);
      expect(report.inspection.driver_name_presence).toEqual({ 'ALEXANDER ALBON': true, 'GABRIEL BORTOLETO': true, 'LANDO NORRIS': true, 'OSCAR PIASTRI': true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed for unreviewed URLs and non-PDF responses', async () => {
    expect(() => validateRound2TimingArtifactUrl('https://www.fia.com/other.pdf')).toThrow('only the reviewed FIA');
    await expect(fetchRound2TimingArtifact(async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>').buffer }))).rejects.toThrow('not a PDF');
    expect(inspectFiaFinalClassificationText('Alexander Albon')).toMatchObject({ driver_name_presence: { 'ALEXANDER ALBON': true, 'LANDO NORRIS': false }, timing_conclusion: 'official_classification_confirms_race_participation_but_not_individual_lap_times' });
  });
});
