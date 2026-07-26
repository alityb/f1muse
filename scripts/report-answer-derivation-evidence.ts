import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { buildAnswerDerivationReport } from '../src/f1ql/answer-derivation-report';
import { verifyAnswerDerivationEvidence } from '../src/f1ql/answer-derivation-evidence';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const MAXIMUM_ARTIFACT_BYTES = 1_000_000;

export function reportAnswerDerivationEvidenceFile(path: string, env: NodeJS.ProcessEnv = process.env) {
  const content = readBounded(path);
  const artifact = verifyAnswerDerivationEvidence(answerEvaluationManifest, JSON.parse(content.toString('utf8')), {
    key_id: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_KEY_ID'),
    public_key_base64: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64')
  });
  return buildAnswerDerivationReport(
    answerEvaluationManifest,
    answerMetamorphicGroups,
    artifact,
    createHash('sha256').update(content).digest('hex')
  );
}

function readBounded(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_ARTIFACT_BYTES) throw new Error('answer_derivation_report_input_invalid');
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) throw new Error('answer_derivation_report_input_incomplete');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, content.length) !== 0) throw new Error('answer_derivation_report_input_grew');
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('answer_derivation_report_input_changed');
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length > 10_000) throw new Error('answer_derivation_report_environment_invalid');
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('answer_derivation_report_arguments_invalid');
  process.stdout.write(`${JSON.stringify(reportAnswerDerivationEvidenceFile(args[0]))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  }
}
