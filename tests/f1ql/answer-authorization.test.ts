import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AnswerAuthorizationError, buildAnswerExecutionAuthorization } from '../../src/f1ql/answer-authorization';
import { authorizeAnswerProgram } from '../../src/f1ql/answer-policy';
import { F1QLProgram } from '../../src/f1ql/ast';

const program: F1QLProgram = {
  version: 1,
  root: {
    op: 'aggregate',
    input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } },
    group_by: ['driver_id'],
    measures: [{ as: 'points', function: 'max', field: 'points' }]
  }
};

describe('answer execution authorization', () => {
  afterEach(() => delete process.env.F1QL_DEFINITIONS_VERSION);

  it('binds an approved capability, request, principal, hash, and active versions', () => {
    const decision = authorizeAnswerProgram(program);
    expect(decision.type).toBe('approved');
    if (decision.type !== 'approved') return;

    const authorization = buildAnswerExecutionAuthorization(randomUUID(), 'internal', program, decision.capability);
    expect(authorization).toMatchObject({
      version: 1,
      principal_class: 'internal',
      capability: decision.capability,
      active_versions: {
        definitions: 'v2',
        compiler: 'core-v1',
        fact_space: 'source-views-v1',
        work_model: 'answer-work-v1'
      }
    });
    expect(authorization.program_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid request identities and mismatched capabilities', () => {
    const decision = authorizeAnswerProgram(program);
    expect(decision.type).toBe('approved');
    if (decision.type !== 'approved') return;

    expect(() => buildAnswerExecutionAuthorization('caller-controlled', 'internal', program, decision.capability)).toThrow(AnswerAuthorizationError);
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'internal', program, { ...decision.capability, season: 2024 })).toThrow(AnswerAuthorizationError);
  });

  it('rejects inactive definitions and runtime-invalid principal classes', () => {
    const decision = authorizeAnswerProgram(program);
    expect(decision.type).toBe('approved');
    if (decision.type !== 'approved') return;

    process.env.F1QL_DEFINITIONS_VERSION = 'inactive';
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'internal', program, decision.capability)).toThrow(AnswerAuthorizationError);
    delete process.env.F1QL_DEFINITIONS_VERSION;
    expect(() => buildAnswerExecutionAuthorization(randomUUID(), 'public' as 'internal', program, decision.capability)).toThrow(AnswerAuthorizationError);
  });

  it('retains the deterministically re-authorized capability rather than caller-owned input', () => {
    const decision = authorizeAnswerProgram(program);
    expect(decision.type).toBe('approved');
    if (decision.type !== 'approved') return;

    const supplied = { ...decision.capability };
    const authorization = buildAnswerExecutionAuthorization(randomUUID(), 'internal', program, supplied);
    supplied.season = 2024;
    expect(authorization.capability.season).toBe(2025);
    expect(() => { (authorization as { principal_class: string }).principal_class = 'public'; }).toThrow();
    expect(() => { (authorization.capability as { season: number }).season = 2024; }).toThrow();
    expect(() => { (authorization.capability.filters as string[]).push('driver'); }).toThrow();
    expect(() => { (authorization.active_versions as { definitions: string }).definitions = 'inactive'; }).toThrow();
  });
});
