import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type ArtifactKind = 'production-golden' | 'database-authority-audit' | 'pace-v2-preflight' | 'f1ql-performance-evidence';

interface PreparedArtifact {
  kind: ArtifactKind;
  source_available: boolean;
  report: unknown;
}

interface Arguments {
  commit: string;
  output: string;
  golden: string;
  authority: string;
  pace: string;
  performance: string;
  shadow: string;
}

function redactString(value: string): string {
  return value.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"',\]}]+/gi, '[redacted-url]');
}

function redact(value: unknown, key?: string): unknown {
  if (key && /(authorization|credential|database_url|password|secret|token)/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

function readJsonArtifact(kind: ArtifactKind, path: string): PreparedArtifact {
  try {
    return { kind, source_available: true, report: redact(JSON.parse(readFileSync(path, 'utf8'))) };
  } catch {
    return { kind, source_available: false, report: { status: 'unavailable_or_invalid_output' } };
  }
}

function readShadowReport(path: string): string {
  try {
    return redactString(readFileSync(path, 'utf8'));
  } catch {
    return '# F1QL Shadow Translation Review\n\n- Status: unavailable_or_invalid_output\n';
  }
}

export function prepareNightlyVerificationArtifacts(args: Arguments, generatedAtUtc = new Date().toISOString()): void {
  mkdirSync(args.output, { recursive: true });
  const reports = [
    readJsonArtifact('production-golden', args.golden),
    readJsonArtifact('database-authority-audit', args.authority),
    readJsonArtifact('pace-v2-preflight', args.pace),
    readJsonArtifact('f1ql-performance-evidence', args.performance)
  ];
  const metadata = {
    generated_at_utc: generatedAtUtc,
    commit: args.commit,
    reports: reports.map(({ kind, source_available, report }) => ({
      kind,
      source_available,
      status: typeof report === 'object' && report !== null && 'status' in report ? report.status : 'unknown'
    }))
  };

  for (const artifact of reports) {
    writeFileSync(join(args.output, `${artifact.kind}.json`), `${JSON.stringify(artifact.report, null, 2)}\n`, { mode: 0o600 });
  }
  writeFileSync(join(args.output, 'f1ql-shadow-review.md'), readShadowReport(args.shadow), { mode: 0o600 });
  writeFileSync(join(args.output, 'verification-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error('Expected paired --flag value arguments.');
    values.set(flag.slice(2), value);
  }
  const required = ['commit', 'output', 'golden', 'authority', 'pace', 'performance', 'shadow'] as const;
  for (const key of required) if (!values.has(key)) throw new Error(`Missing --${key}.`);
  return Object.fromEntries(required.map(key => [key, values.get(key)!])) as Arguments;
}

if (require.main === module) {
  try {
    prepareNightlyVerificationArtifacts(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`Unable to prepare nightly verification artifacts: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
