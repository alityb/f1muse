import { AnswerRuntimeConfig } from './answer-runtime';
import {
  AnswerReleaseVerificationInput,
  loadDeterministicAnswerReleaseVerificationInput
} from './answer-release-attestation';
import { getConfiguredAnswerModelIdentity } from './answer-translator';

export function loadAnswerReleaseVerificationInput(
  runtimeConfig: AnswerRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now()
): AnswerReleaseVerificationInput {
  const loaded = loadDeterministicAnswerReleaseVerificationInput(runtimeConfig, env, nowMs);
  const model = getConfiguredAnswerModelIdentity(env);
  return {
    ...loaded,
    active_context: {
      ...loaded.active_context,
      provider: model.provider,
      model_id: model.model_id,
      endpoint_sha256: model.endpoint_sha256,
      reasoning_effort: model.reasoning_effort
    }
  };
}
