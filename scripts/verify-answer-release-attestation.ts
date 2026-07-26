import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  getAnswerReleaseAttestationHash,
  verifyAnswerReleaseAttestation
} from '../src/f1ql/answer-release-attestation';
import { loadAnswerReleaseVerificationInput } from '../src/f1ql/answer-release-provider-verification';
import { getAnswerRuntimeConfig } from '../src/f1ql/answer-runtime';

const MAXIMUM_ATTESTATION_BYTES = 100_000;

export interface AnswerReleaseVerificationResult {
  readonly status: 'pass';
  readonly sha256: string;
  readonly key_id: string;
}

export function verifyAnswerReleaseAttestationFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): AnswerReleaseVerificationResult {
  const raw = readAttestation(path);
  const loaded = loadAnswerReleaseVerificationInput(getAnswerRuntimeConfig(env), {
    ...env,
    F1QL_ANSWER_RELEASE_ATTESTATION: raw
  }, nowMs);
  const verified = verifyAnswerReleaseAttestation(
    loaded.raw_attestation,
    loaded.trusted_key,
    loaded.active_context,
    loaded.temporal_policy
  );
  return { status: 'pass', sha256: getAnswerReleaseAttestationHash(verified), key_id: verified.key_id };
}

function readAttestation(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096 || path.includes('\0')) {
    throw new Error('answer_release_path_invalid');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAXIMUM_ATTESTATION_BYTES) {
      throw new Error('answer_release_attestation_file_invalid');
    }
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.byteLength) {
      const count = readSync(descriptor, content, offset, content.byteLength - offset, offset);
      if (count === 0) throw new Error('answer_release_attestation_read_incomplete');
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, content.byteLength) !== 0) {
      throw new Error('answer_release_attestation_grew');
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('answer_release_attestation_changed');
    }
    return content.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('answer_release_verify_arguments_invalid');
  process.stdout.write(`${JSON.stringify(verifyAnswerReleaseAttestationFile(args[0]))}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{"status":"refused"}\n');
    process.exitCode = 1;
  }
}
