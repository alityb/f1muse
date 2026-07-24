import { AnswerCapability, authorizeAnswerProgram } from './answer-policy';
import { ANSWER_WORK_MODEL_VERSION } from './answer-bounds';
import { F1QLProgram } from './ast';
import { F1QL_DEFINITIONS_VERSION, validateF1QLProgram } from './validation';
import { F1QL_COMPILER_VERSION, F1QL_FACT_SPACE_VERSION, getF1QLProgramHash } from './verified-programs';

export const ANSWER_AUTHORIZATION_VERSION = 1;
export type AnswerPrincipalClass = 'internal';
type AuthorizedAnswerCapability = Readonly<Omit<AnswerCapability, 'filters'>> & {
  readonly filters: ReadonlyArray<AnswerCapability['filters'][number]>;
};

export interface AnswerExecutionAuthorization {
  readonly version: typeof ANSWER_AUTHORIZATION_VERSION;
  readonly request_id: string;
  readonly principal_class: AnswerPrincipalClass;
  readonly program_hash: string;
  readonly capability: AuthorizedAnswerCapability;
  readonly active_versions: {
    readonly definitions: string;
    readonly compiler: string;
    readonly fact_space: string;
    readonly work_model: string;
  };
}

export class AnswerAuthorizationError extends Error {}

export function buildAnswerExecutionAuthorization(
  requestId: string,
  principalClass: AnswerPrincipalClass,
  program: F1QLProgram,
  capability: AnswerCapability
): AnswerExecutionAuthorization {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new AnswerAuthorizationError('Answer request identity must be a UUID');
  }
  if (principalClass !== 'internal') {
    throw new AnswerAuthorizationError('Answer principal class is not authorized');
  }
  try {
    validateF1QLProgram(program);
  } catch {
    throw new AnswerAuthorizationError('Program is not valid under the active definitions');
  }
  const decision = authorizeAnswerProgram(program);
  if (decision.type !== 'approved' || JSON.stringify(decision.capability) !== JSON.stringify(capability)) {
    throw new AnswerAuthorizationError('Program and approved capability did not match');
  }
  const authorizedCapability = {
    ...decision.capability,
    filters: Object.freeze([...decision.capability.filters])
  };
  Object.freeze(authorizedCapability);
  const activeVersions = Object.freeze({
    definitions: F1QL_DEFINITIONS_VERSION,
    compiler: F1QL_COMPILER_VERSION,
    fact_space: F1QL_FACT_SPACE_VERSION,
    work_model: ANSWER_WORK_MODEL_VERSION
  });
  return Object.freeze({
    version: ANSWER_AUTHORIZATION_VERSION,
    request_id: requestId,
    principal_class: principalClass,
    program_hash: getF1QLProgramHash(program),
    capability: authorizedCapability,
    active_versions: activeVersions
  });
}
