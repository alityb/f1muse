import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const ROUND_2_FIA_FINAL_CLASSIFICATION_URL = 'https://www.fia.com/system/files/decision-document/2026_chinese_grand_prix_-_final_race_classification.pdf';

const REQUIRED_DRIVER_NAMES = ['ALEXANDER ALBON', 'GABRIEL BORTOLETO', 'LANDO NORRIS', 'OSCAR PIASTRI'];

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface TimingArtifactReport {
  version: 1;
  authority: 'FIA';
  source_url: string;
  retrieved_at: string;
  output: string;
  artifact_sha256: string;
  bytes: number;
  content_type: string | null;
  inspection: {
    artifact_kind: 'final_race_classification';
    driver_name_presence: Record<string, boolean>;
    timing_conclusion: 'official_classification_confirms_race_participation_but_not_individual_lap_times';
  };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function validateRound2TimingArtifactUrl(sourceUrl: string): void {
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.fia.com' || url.href !== ROUND_2_FIA_FINAL_CLASSIFICATION_URL) {
    throw new Error('FAIL_CLOSED: only the reviewed FIA 2026 round-2 final-classification URL may be fetched');
  }
}

export function inspectFiaFinalClassificationText(text: string): TimingArtifactReport['inspection'] {
  const normalized = text.replace(/\s+/g, ' ').toUpperCase();
  return {
    artifact_kind: 'final_race_classification',
    driver_name_presence: Object.fromEntries(REQUIRED_DRIVER_NAMES.map((name) => [name, normalized.includes(name)])),
    // A final classification is not a lap-by-lap timing feed. Never derive a lap time from it.
    timing_conclusion: 'official_classification_confirms_race_participation_but_not_individual_lap_times'
  };
}

export async function fetchRound2TimingArtifact(
  fetcher: (url: string) => Promise<FetchResponse> = (url) => fetch(url) as Promise<FetchResponse>,
  now: () => Date = () => new Date(),
  sourceUrl = ROUND_2_FIA_FINAL_CLASSIFICATION_URL
): Promise<{ content: Buffer; content_type: string | null; retrieved_at: string }> {
  validateRound2TimingArtifactUrl(sourceUrl);
  const response = await fetcher(sourceUrl);
  if (!response.ok) throw new Error(`FAIL_CLOSED: FIA artifact request failed with status ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type');
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-')) || (contentType && !contentType.toLowerCase().includes('pdf'))) {
    throw new Error('FAIL_CLOSED: FIA artifact is not a PDF');
  }
  return { content, content_type: contentType, retrieved_at: now().toISOString() };
}

export function writeRound2TimingArtifact(
  artifact: { content: Buffer; content_type: string | null; retrieved_at: string },
  extractedText: string,
  temporaryDirectory = os.tmpdir()
): TimingArtifactReport {
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'pace-v2-round2-fia-'), { encoding: 'utf8' });
  const output = path.join(directory, 'final-race-classification.pdf');
  fs.writeFileSync(output, artifact.content, { encoding: 'binary', flag: 'wx', mode: 0o600 });
  return {
    version: 1,
    authority: 'FIA',
    source_url: ROUND_2_FIA_FINAL_CLASSIFICATION_URL,
    retrieved_at: artifact.retrieved_at,
    output,
    artifact_sha256: sha256(artifact.content),
    bytes: artifact.content.length,
    content_type: artifact.content_type,
    inspection: inspectFiaFinalClassificationText(extractedText)
  };
}

async function main(): Promise<void> {
  const artifact = await fetchRound2TimingArtifact();
  const uninspected = writeRound2TimingArtifact(artifact, '');
  let extractedText: string;
  try {
    extractedText = execFileSync('pdftotext', [uninspected.output, '-'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  } catch {
    throw new Error('FAIL_CLOSED: unable to inspect the retained FIA PDF with pdftotext');
  }
  const report = { ...uninspected, inspection: inspectFiaFinalClassificationText(extractedText) };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'refused', error: error instanceof Error ? error.message : 'pace_v2_round2_timing_artifact_failed' })}\n`);
  process.exitCode = 1;
});
