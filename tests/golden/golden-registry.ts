import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  GoldenAssertionSchema,
  GoldenCase,
  GoldenCaseRegistry,
  GoldenCaseRegistrySchema,
} from '../../src/quality/golden-case';

const registryPath = resolve(process.cwd(), 'tests/golden/known-incidents.json');

export const goldenRegistry: GoldenCaseRegistry = GoldenCaseRegistrySchema.parse(
  JSON.parse(readFileSync(registryPath, 'utf8'))
);

export function getGoldenCase(id: string): GoldenCase {
  const golden = goldenRegistry.cases.find((candidate) => candidate.id === id);
  if (!golden) {
    throw new Error(`Golden case not found: ${id}`);
  }
  return golden;
}

export function getGoldenAssertion(
  golden: GoldenCase,
  subject: string,
  metric: string
): number | string | boolean | null {
  const assertion = golden.assertions.find(
    (candidate) => candidate.subject === subject && candidate.metric === metric
  );
  if (!assertion) {
    throw new Error(`Golden assertion not found: ${golden.id}/${subject}/${metric}`);
  }

  return GoldenAssertionSchema.parse(assertion).equals;
}
