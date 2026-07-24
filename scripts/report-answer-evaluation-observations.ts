import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { buildAnswerObservationReport } from '../src/f1ql/answer-observation-report';
import { parseAnswerObservationArtifact, validateAnswerObservationArtifact, verifyAnswerObservationArtifact } from '../src/f1ql/answer-observations';
import { answerEvaluationManifest, answerMetamorphicGroups } from '../tests/fixtures/f1ql-answer-evaluation-manifest';

const MAXIMUM_ARTIFACT_BYTES = 1_000_000;

export function reportAnswerObservationFile(path: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof buildAnswerObservationReport> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let content: Buffer;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new Error('answer_observation_artifact_not_regular_file');
    }
    const size = metadata.size;
    if (size < 1 || size > MAXIMUM_ARTIFACT_BYTES) {
      throw new Error('answer_observation_artifact_size_invalid');
    }
    content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, content, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw new Error('answer_observation_artifact_read_incomplete');
      }
      offset += bytesRead;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, size) !== 0) {
      throw new Error('answer_observation_artifact_changed_during_read');
    }
  } finally {
    closeSync(descriptor);
  }
  const input = JSON.parse(content.toString('utf8'));
  const parsed = parseAnswerObservationArtifact(input);
  const artifact = parsed.version === 3
    ? verifyAnswerObservationArtifact(answerEvaluationManifest, input, {
      key_id: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_KEY_ID'),
      public_key_base64: requiredEnvironment(env, 'F1QL_ANSWER_EVALUATION_PUBLIC_KEY_BASE64')
    })
    : validateAnswerObservationArtifact(answerEvaluationManifest, parsed);
  return buildAnswerObservationReport(
    answerEvaluationManifest,
    answerMetamorphicGroups,
    artifact,
    createHash('sha256').update(content).digest('hex')
  );
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error('Usage: report:answer-evaluation <observations.json>');
  }
  process.stdout.write(`${JSON.stringify(reportAnswerObservationFile(args[0]))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused","error":"answer_observation_report_invalid"}\n');
    process.exitCode = 1;
  }
}
