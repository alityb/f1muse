import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { compilePlannedF1QL } from '../src/f1ql/planned-compiler';
import { PLANNED_F1QL_MAX_ROWS, PLANNED_F1QL_MAX_WORK_UNITS } from '../src/f1ql/planned-f1ql';
import { interpretPlannedF1QL, PlannedReferenceDatabase } from '../src/f1ql/planned-interpreter';
import { planSemanticAnswerFromResolution } from '../src/f1ql/semantic-planner';
import {
  collectSemanticResolutionEvidence,
  SEMANTIC_RESOLVER_MAX_CANDIDATES
} from '../src/f1ql/semantic-resolution-evidence';
import { getSemanticPlanProofParent, proveSemanticAnswerPlan } from '../src/f1ql/semantic-plan-proof';
import { formatSemanticPlanResult } from '../src/f1ql/semantic-result-format';
import {
  admitSemanticQueryCandidates,
  enumerateSemanticQueries,
  SEMANTIC_QUERY_VERSION,
  verifySemanticEvidence
} from '../src/f1ql/semantic-query';
import { z } from 'zod';

export const WORST_CASE_BENCHMARK_VERSION = 'phase11-wp7-worst-case-v1' as const;
export const WORST_CASE_BENCHMARK_METADATA_PATH = path.resolve(
  process.cwd(),
  'metadata/phase11-wp7-worst-case-benchmark.json'
);

const ZERO_HASH = '0'.repeat(64);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const topologySchema = z.enum(['single_source_rows', 'row_dimension_join', 'scalar_aggregate_compose']);
const familySchema = z.enum(['single_source', 'safe_dimension_join', 'aggregate_locality']);
const entitySchema = z.object({
  type: z.enum(['driver', 'event']),
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7)
}).strict();
const mentionSchema = z.object({
  text: z.string().min(1).max(200),
  occurrence: z.number().int().min(0).max(7),
  candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).min(1).max(SEMANTIC_RESOLVER_MAX_CANDIDATES),
  active_candidates: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/)).min(1).max(SEMANTIC_RESOLVER_MAX_CANDIDATES)
}).strict();
const eventResolutionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('missing') }).strict(),
  z.object({
    type: z.literal('resolved'),
    season: z.number().int().min(1950).max(2100),
    round: z.number().int().min(1).max(30)
  }).strict()
]);
const hashSetSchema = z.object({
  question_sha256: sha256Schema,
  answer_plan_sha256: sha256Schema,
  proof_sha256: sha256Schema,
  core_sha256: sha256Schema,
  compiled_sha256: sha256Schema,
  reference_output_sha256: sha256Schema,
  formatter_output_sha256: sha256Schema
}).strict();
const workloadSchema = z.object({
  id: z.enum(['maximum_rows_standings', 'maximum_rows_safe_join', 'maximum_work_and_resolver_compose']),
  family: familySchema,
  boundary: z.enum(['maximum_rows', 'family_coverage', 'maximum_work_and_resolver_candidates']),
  question: z.string().min(1).max(1_000),
  entities: z.array(entitySchema).max(8),
  resolver: z.object({
    driver_mentions: z.array(mentionSchema).max(8),
    event_resolution: eventResolutionSchema
  }).strict(),
  expected: z.object({
    topology: topologySchema,
    work_units: z.number().int().min(1),
    requested_rows: z.number().int().min(1),
    resolver_candidates: z.number().int().min(0),
    reference_rows: z.number().int().min(1),
    hashes: hashSetSchema
  }).strict()
}).strict();
const definitionsSchema = z.object({
  schema_version: z.literal(1),
  benchmark_version: z.literal(WORST_CASE_BENCHMARK_VERSION),
  emitter: z.object({
    version: z.literal('phase11-worst-case-emitter-v1'),
    script: z.literal('scripts/snapshot-phase11-worst-case-benchmark.ts')
  }).strict().optional(),
  database: z.literal('none'),
  warmup_passes: z.number().int().min(1).max(100),
  measured_passes: z.number().int().min(1).max(1_000),
  safety_ceiling_ms_per_stage_pass: z.number().finite().positive().max(60_000),
  timing_contract: z.object({
    scope: z.literal('local_observational_safety_only'),
    production_capability_threshold: z.literal('not_evaluated'),
    statistics: z.tuple([z.literal('p50'), z.literal('p95')])
  }).strict(),
  legal_limits: z.object({
    maximum_work_units: z.literal(PLANNED_F1QL_MAX_WORK_UNITS),
    maximum_rows: z.literal(PLANNED_F1QL_MAX_ROWS),
    maximum_resolver_candidates_per_mention: z.literal(SEMANTIC_RESOLVER_MAX_CANDIDATES)
  }).strict(),
  workloads: z.array(workloadSchema).length(3)
}).strict().superRefine((definitions, context) => {
  const workloads = definitions.workloads;
  if (new Set(workloads.map(item => item.id)).size !== workloads.length ||
      new Set(workloads.map(item => item.family)).size !== familySchema.options.length ||
      new Set(workloads.map(item => item.boundary)).size !== workloads.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'benchmark workloads, families, and boundaries must be unique' });
  }
  if (Math.max(...workloads.map(item => item.expected.work_units)) !== PLANNED_F1QL_MAX_WORK_UNITS ||
      Math.max(...workloads.map(item => item.expected.requested_rows)) !== PLANNED_F1QL_MAX_ROWS ||
      Math.max(...workloads.map(item => item.expected.resolver_candidates)) !== SEMANTIC_RESOLVER_MAX_CANDIDATES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'benchmark must attain current legal work, row, and resolver limits' });
  }
  if (workloads.some(item => item.expected.work_units > PLANNED_F1QL_MAX_WORK_UNITS ||
      item.expected.requested_rows > PLANNED_F1QL_MAX_ROWS ||
      item.expected.resolver_candidates > SEMANTIC_RESOLVER_MAX_CANDIDATES)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'benchmark workload exceeds a current legal limit' });
  }
  const familyTopologies = {
    single_source: 'single_source_rows',
    safe_dimension_join: 'row_dimension_join',
    aggregate_locality: 'scalar_aggregate_compose'
  } as const;
  if (workloads.some(item => familyTopologies[item.family] !== item.expected.topology) ||
      workloads.some(item => item.boundary === 'maximum_rows' && item.expected.requested_rows !== PLANNED_F1QL_MAX_ROWS) ||
      workloads.some(item => item.boundary === 'maximum_work_and_resolver_candidates' &&
        (item.expected.work_units !== PLANNED_F1QL_MAX_WORK_UNITS ||
          item.expected.resolver_candidates !== SEMANTIC_RESOLVER_MAX_CANDIDATES))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'benchmark family or declared boundary is inconsistent' });
  }
});

export type WorstCaseBenchmarkDefinitions = z.infer<typeof definitionsSchema>;
type WorkloadDefinition = z.infer<typeof workloadSchema>;
type BenchmarkHashes = z.infer<typeof hashSetSchema>;

interface PreparedWorkload {
  readonly definition: WorkloadDefinition;
  readonly entity_inventory: readonly { readonly type: 'driver' | 'event'; readonly span: LiteralSpan }[];
  readonly evidence: ReturnType<typeof enumerateSemanticQueries>;
  readonly admission: Extract<ReturnType<typeof admitSemanticQueryCandidates>, { type: 'admitted' }>;
  readonly resolution: Awaited<ReturnType<typeof collectSemanticResolutionEvidence>>;
  readonly plan: ReturnType<typeof planSemanticAnswerFromResolution>;
  readonly proof: ReturnType<typeof proveSemanticAnswerPlan>;
  readonly reference_database: PlannedReferenceDatabase;
  readonly hashes: BenchmarkHashes;
}

interface LiteralSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface WorstCaseBenchmarkPreparation {
  readonly definitions: WorstCaseBenchmarkDefinitions;
  readonly definitions_sha256: string;
  readonly workload_count: number;
  readonly fixture_rows_total: number;
  readonly deterministic_sha256: string;
  readonly workloads: ReadonlyArray<{
    readonly family: z.infer<typeof familySchema>;
    readonly boundary: WorkloadDefinition['boundary'];
    readonly topology: z.infer<typeof topologySchema>;
    readonly work_units: number;
    readonly requested_rows: number;
    readonly resolver_candidates: number;
    readonly reference_rows: number;
    readonly hashes: BenchmarkHashes;
  }>;
}

type BenchmarkStage =
  | 'semantic_enumeration_verification_admission_apis'
  | 'resolution_and_planning_apis'
  | 'whole_plan_proof_api'
  | 'proof_parent_verification_and_compiler_apis'
  | 'proof_parent_verification_reference_interpreter_and_formatter_revalidation_apis';

export type WorstCaseBenchmarkReport = Omit<WorstCaseBenchmarkPreparation, 'definitions'> & {
  readonly benchmark_version: typeof WORST_CASE_BENCHMARK_VERSION;
  readonly database: 'none';
  readonly timing_scope: 'local_observational_safety_only';
  readonly production_capability_threshold: 'not_evaluated';
  readonly warmup_passes: number;
  readonly measured_passes: number;
  readonly safety_ceiling_ms_per_stage_pass: number;
  readonly timings_ms_per_workload_set: Readonly<Record<BenchmarkStage, {
    readonly p50: number;
    readonly p95: number;
  }>>;
};

export function createWorstCaseBenchmarkDefinitionSeed(): WorstCaseBenchmarkDefinitions {
  const resolverCandidates = [
    ...Array.from({ length: SEMANTIC_RESOLVER_MAX_CANDIDATES - 1 }, (_unused, index) =>
      `candidate-${String(index + 1).padStart(3, '0')}`),
    'lando-norris'
  ].sort(compareText);
  const hashes = () => ({
    question_sha256: ZERO_HASH,
    answer_plan_sha256: ZERO_HASH,
    proof_sha256: ZERO_HASH,
    core_sha256: ZERO_HASH,
    compiled_sha256: ZERO_HASH,
    reference_output_sha256: ZERO_HASH,
    formatter_output_sha256: ZERO_HASH
  });
  return parseWorstCaseBenchmarkDefinitions({
    schema_version: 1,
    benchmark_version: WORST_CASE_BENCHMARK_VERSION,
    database: 'none',
    warmup_passes: 3,
    measured_passes: 15,
    safety_ceiling_ms_per_stage_pass: 5_000,
    timing_contract: {
      scope: 'local_observational_safety_only',
      production_capability_threshold: 'not_evaluated',
      statistics: ['p50', 'p95']
    },
    legal_limits: {
      maximum_work_units: PLANNED_F1QL_MAX_WORK_UNITS,
      maximum_rows: PLANNED_F1QL_MAX_ROWS,
      maximum_resolver_candidates_per_mention: SEMANTIC_RESOLVER_MAX_CANDIDATES
    },
    workloads: [
      {
        id: 'maximum_rows_standings',
        family: 'single_source',
        boundary: 'maximum_rows',
        question: 'List driver and championship points from final 2025 driver standings.',
        entities: [],
        resolver: { driver_mentions: [], event_resolution: { type: 'missing' } },
        expected: {
          topology: 'single_source_rows', work_units: 1, requested_rows: PLANNED_F1QL_MAX_ROWS,
          resolver_candidates: 0, reference_rows: PLANNED_F1QL_MAX_ROWS, hashes: hashes()
        }
      },
      {
        id: 'maximum_rows_safe_join',
        family: 'safe_dimension_join',
        boundary: 'family_coverage',
        question: 'List driver and finishing position, event name, and circuit identifier for round 1 of final 2025 race classification and event metadata.',
        entities: [],
        resolver: { driver_mentions: [], event_resolution: { type: 'resolved', season: 2025, round: 1 } },
        expected: {
          topology: 'row_dimension_join', work_units: 2, requested_rows: PLANNED_F1QL_MAX_ROWS,
          resolver_candidates: 1, reference_rows: PLANNED_F1QL_MAX_ROWS, hashes: hashes()
        }
      },
      {
        id: 'maximum_work_and_resolver_compose',
        family: 'aggregate_locality',
        boundary: 'maximum_work_and_resolver_candidates',
        question: 'Show count of finishing position from race classification and count of qualifying position from qualifying classification for Norris in final 2025.',
        entities: [{ type: 'driver', text: 'Norris', occurrence: 0 }],
        resolver: {
          driver_mentions: [{
            text: 'Norris', occurrence: 0, candidates: resolverCandidates, active_candidates: ['lando-norris']
          }],
          event_resolution: { type: 'missing' }
        },
        expected: {
          topology: 'scalar_aggregate_compose', work_units: PLANNED_F1QL_MAX_WORK_UNITS, requested_rows: 1,
          resolver_candidates: SEMANTIC_RESOLVER_MAX_CANDIDATES, reference_rows: 1, hashes: hashes()
        }
      }
    ]
  });
}

export function parseWorstCaseBenchmarkDefinitions(input: unknown): WorstCaseBenchmarkDefinitions {
  return deepFreeze(definitionsSchema.parse(input));
}

export function loadWorstCaseBenchmarkDefinitions(
  metadataPath = WORST_CASE_BENCHMARK_METADATA_PATH
): { readonly definitions: WorstCaseBenchmarkDefinitions; readonly definitions_sha256: string } {
  const source = readFileSync(metadataPath);
  return {
    definitions: parseWorstCaseBenchmarkDefinitions(JSON.parse(source.toString('utf8'))),
    definitions_sha256: sha256(source)
  };
}

export async function deriveWorstCaseBenchmarkHashes(
  definitionsInput: unknown
): Promise<Readonly<Record<WorkloadDefinition['id'], BenchmarkHashes>>> {
  const definitions = parseWorstCaseBenchmarkDefinitions(definitionsInput);
  const prepared = await Promise.all(definitions.workloads.map(item => prepareWorkload(item, false)));
  return deepFreeze(Object.fromEntries(prepared.map(item => [item.definition.id, item.hashes]))) as
    Readonly<Record<WorkloadDefinition['id'], BenchmarkHashes>>;
}

export async function prepareWorstCaseBenchmark(
  definitionsInput: unknown,
  definitionsSha256?: string
): Promise<WorstCaseBenchmarkPreparation> {
  const definitions = parseWorstCaseBenchmarkDefinitions(definitionsInput);
  const prepared = await Promise.all(definitions.workloads.map(item => prepareWorkload(item)));
  const workloads = prepared.map(item => {
    const parent = getSemanticPlanProofParent(item.proof);
    const rows = interpretPlannedF1QL(parent.core_program, item.reference_database);
    formatSemanticPlanResult(item.proof, rows);
    return {
      family: item.definition.family,
      boundary: item.definition.boundary,
      topology: item.plan.topology as z.infer<typeof topologySchema>,
      work_units: item.plan.work.source_scan_units,
      requested_rows: item.plan.work.requested_rows,
      resolver_candidates: item.plan.work.resolver_candidates,
      reference_rows: rows.length,
      hashes: item.hashes
    };
  });
  const fixtureRowsTotal = workloads.reduce((total, item) => total + item.reference_rows, 0);
  if (prepared.length !== familySchema.options.length || fixtureRowsTotal === 0 ||
      workloads.some(item => item.reference_rows === 0)) {
    throw new Error('worst-case benchmark requires one non-empty workload per current plan family');
  }
  return deepFreeze({
    definitions,
    definitions_sha256: definitionsSha256 ?? sha256(Buffer.from(stableSerialize(definitions), 'utf8')),
    workload_count: workloads.length,
    fixture_rows_total: fixtureRowsTotal,
    deterministic_sha256: sha256(Buffer.from(stableSerialize(workloads), 'utf8')),
    workloads
  });
}

export async function runWorstCaseBenchmark(
  definitionsInput: unknown,
  definitionsSha256?: string
): Promise<WorstCaseBenchmarkReport> {
  const preparation = await prepareWorstCaseBenchmark(definitionsInput, definitionsSha256);
  const prepared = await Promise.all(preparation.definitions.workloads.map(item => prepareWorkload(item)));
  const stages = benchmarkStages(preparation.definitions, prepared);
  const timings = {} as Record<BenchmarkStage, { p50: number; p95: number }>;
  for (const stage of Object.keys(stages) as BenchmarkStage[]) {
    const samples = await measure(
      stages[stage],
      preparation.definitions.warmup_passes,
      preparation.definitions.measured_passes,
      preparation.definitions.safety_ceiling_ms_per_stage_pass
    );
    timings[stage] = { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
  }
  return deepFreeze({
    definitions_sha256: preparation.definitions_sha256,
    workload_count: preparation.workload_count,
    fixture_rows_total: preparation.fixture_rows_total,
    deterministic_sha256: preparation.deterministic_sha256,
    workloads: preparation.workloads,
    benchmark_version: WORST_CASE_BENCHMARK_VERSION,
    database: 'none' as const,
    timing_scope: preparation.definitions.timing_contract.scope,
    production_capability_threshold: preparation.definitions.timing_contract.production_capability_threshold,
    warmup_passes: preparation.definitions.warmup_passes,
    measured_passes: preparation.definitions.measured_passes,
    safety_ceiling_ms_per_stage_pass: preparation.definitions.safety_ceiling_ms_per_stage_pass,
    timings_ms_per_workload_set: timings
  });
}

function benchmarkStages(
  definitions: WorstCaseBenchmarkDefinitions,
  prepared: readonly PreparedWorkload[]
): Record<BenchmarkStage, () => Promise<number>> {
  return {
    semantic_enumeration_verification_admission_apis: async () => {
      let consumed = 0;
      for (const item of definitions.workloads) {consumed += createEvidenceArtifacts(item).admission.query_hash.length;}
      return consumed;
    },
    resolution_and_planning_apis: async () => {
      let consumed = 0;
      for (const item of prepared) {
        const resolution = await createResolution(item.definition, item.admission);
        consumed += planSemanticAnswerFromResolution({
          question: item.definition.question, admission: item.admission, resolution
        }).answer_plan_hash.length;
      }
      return consumed;
    },
    whole_plan_proof_api: async () => {
      let consumed = 0;
      for (const item of prepared) {
        consumed += proveSemanticAnswerPlan({
          question: item.definition.question,
          entity_inventory: item.entity_inventory,
          evidence: item.evidence,
          admission: item.admission,
          resolution: item.resolution,
          plan: item.plan
        }).proof_hash.length;
      }
      return consumed;
    },
    proof_parent_verification_and_compiler_apis: async () => {
      let consumed = 0;
      for (const item of prepared) {
        consumed += compilePlannedF1QL(getSemanticPlanProofParent(item.proof).core_program).sql.length;
      }
      return consumed;
    },
    proof_parent_verification_reference_interpreter_and_formatter_revalidation_apis: async () => {
      let consumed = 0;
      for (const item of prepared) {
        const parent = getSemanticPlanProofParent(item.proof);
        const rows = interpretPlannedF1QL(parent.core_program, item.reference_database);
        consumed += formatSemanticPlanResult(item.proof, rows).rows.length;
      }
      return consumed;
    }
  };
}

async function prepareWorkload(definition: WorkloadDefinition, enforceExpectedHashes = true): Promise<PreparedWorkload> {
  const { entityInventory, evidence, admission } = createEvidenceArtifacts(definition);
  const resolution = await createResolution(definition, admission);
  const plan = planSemanticAnswerFromResolution({ question: definition.question, admission, resolution });
  const proof = proveSemanticAnswerPlan({
    question: definition.question, entity_inventory: entityInventory, evidence, admission, resolution, plan
  });
  const parent = getSemanticPlanProofParent(proof);
  const referenceDatabase = referenceDatabaseFor(definition.id);
  const rows = interpretPlannedF1QL(parent.core_program, referenceDatabase);
  const formatted = formatSemanticPlanResult(proof, rows);
  const hashes = {
    question_sha256: proof.question_sha256,
    answer_plan_sha256: plan.answer_plan_hash,
    proof_sha256: proof.proof_hash,
    core_sha256: parent.core_hash,
    compiled_sha256: sha256(Buffer.from(stableSerialize(parent.compiled), 'utf8')),
    reference_output_sha256: sha256(Buffer.from(stableSerialize(rows), 'utf8')),
    formatter_output_sha256: sha256(Buffer.from(stableSerialize(formatted), 'utf8'))
  };
  if (plan.topology !== definition.expected.topology ||
      plan.work.source_scan_units !== definition.expected.work_units ||
      plan.work.requested_rows !== definition.expected.requested_rows ||
      plan.work.resolver_candidates !== definition.expected.resolver_candidates ||
      rows.length !== definition.expected.reference_rows ||
      (enforceExpectedHashes && stableSerialize(hashes) !== stableSerialize(definition.expected.hashes))) {
    throw new Error(`worst-case benchmark definition drift: ${definition.id}`);
  }
  return {
    definition, entity_inventory: entityInventory, evidence, admission, resolution, plan, proof,
    reference_database: referenceDatabase, hashes
  };
}

function createEvidenceArtifacts(definition: WorkloadDefinition) {
  const entityInventory = definition.entities.map(entity => ({
    type: entity.type,
    span: materializeSpan(definition.question, entity.text, entity.occurrence)
  }));
  const evidence = enumerateSemanticQueries(definition.question, entityInventory);
  verifySemanticEvidence(evidence, definition.question, entityInventory);
  if (evidence.type !== 'candidate_set') {throw new Error('benchmark evidence unexpectedly abstained');}
  const admission = admitSemanticQueryCandidates({
    version: SEMANTIC_QUERY_VERSION,
    candidates: evidence.candidates
  }, definition.question, evidence);
  if (admission.type !== 'admitted') {throw new Error('benchmark evidence was not uniquely admitted');}
  return { entityInventory, evidence, admission };
}

async function createResolution(
  definition: WorkloadDefinition,
  admission: Extract<ReturnType<typeof admitSemanticQueryCandidates>, { type: 'admitted' }>
) {
  const mentions = definition.resolver.driver_mentions.map(mention => ({
    ...materializeSpan(definition.question, mention.text, mention.occurrence),
    candidates: mention.candidates,
    active_candidates: mention.active_candidates
  }));
  return collectSemanticResolutionEvidence({
    question: definition.question,
    admission,
    driver_resolver: { inventoryMentions: async () => mentions },
    event_resolver: {
      resolve: async () => definition.resolver.event_resolution,
      resolveRound: async () => definition.resolver.event_resolution
    }
  });
}

function referenceDatabaseFor(id: WorkloadDefinition['id']): PlannedReferenceDatabase {
  if (id === 'maximum_rows_standings') {return standingsReferenceDatabase();}
  if (id === 'maximum_rows_safe_join') {return safeJoinReferenceDatabase();}
  const rounds = Array.from({ length: 30 }, (_unused, index) => index + 1);
  return {
    event_classification: rounds.map(round => raceRow(round, 'lando-norris', (round % 20) + 1)),
    qualifying_classification: rounds.map(round => ({
      season: 2025, round, driver_id: 'lando-norris', team_id: 'mclaren',
      qualifying_position: (round % 20) + 1, best_time_ms: 80_000 + round,
      best_session: 'Q3', eliminated_in_round: null, classification_status: 'classified'
    }))
  };
}

function standingsReferenceDatabase(): PlannedReferenceDatabase {
  return {
    driver_standings: Array.from({ length: PLANNED_F1QL_MAX_ROWS }, (_unused, index) => ({
      season: 2025,
      driver_id: `benchmark-driver-${String(index + 1).padStart(3, '0')}`,
      championship_position: index + 1,
      championship_won: index === 0,
      points: String(500 - index)
    }))
  };
}

function safeJoinReferenceDatabase(): PlannedReferenceDatabase {
  return {
    event_classification: Array.from({ length: PLANNED_F1QL_MAX_ROWS }, (_unused, index) =>
      raceRow(1, `benchmark-driver-${String(index + 1).padStart(3, '0')}`, index < 30 ? index + 1 : null)),
    event_metadata: [{
      season: 2025, round: 1, event_id: 'benchmark-grand-prix', event_name: 'Benchmark Grand Prix',
      circuit_id: 'benchmark-circuit', date: '2025-01-01'
    }]
  };
}

function raceRow(round: number, driverId: string, position: number | null) {
  return {
    season: 2025, round, driver_id: driverId, team_id: 'benchmark-team', finishing_position: position,
    points: position === null ? '0' : '1', classification_status: position === null ? 'dnf' : 'classified',
    status_reason: position === null ? 'not classified' : null
  };
}

async function measure(
  action: () => Promise<number>,
  warmupPasses: number,
  measuredPasses: number,
  safetyCeiling: number
): Promise<number[]> {
  let consumed = 0;
  for (let index = 0; index < warmupPasses; index += 1) {
    consumed += await timedAction(action, safetyCeiling);
  }
  const samples: number[] = [];
  for (let index = 0; index < measuredPasses; index += 1) {
    const started = performance.now();
    consumed += await action();
    const elapsed = performance.now() - started;
    enforceSafetyCeiling(elapsed, safetyCeiling);
    samples.push(elapsed);
  }
  if (consumed <= 0 || samples.length === 0) {throw new Error('worst-case benchmark stage did no observable work');}
  return samples;
}

async function timedAction(action: () => Promise<number>, safetyCeiling: number): Promise<number> {
  const started = performance.now();
  const consumed = await action();
  enforceSafetyCeiling(performance.now() - started, safetyCeiling);
  return consumed;
}

function enforceSafetyCeiling(elapsed: number, safetyCeiling: number): void {
  if (elapsed > safetyCeiling) {throw new Error(`worst-case benchmark safety ceiling exceeded: ${elapsed}`);}
}

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function materializeSpan(question: string, text: string, occurrence: number): LiteralSpan {
  const questionPoints = Array.from(question.normalize('NFKC').trim());
  const textPoints = Array.from(text);
  const starts = questionPoints.flatMap((_point, index) =>
    textPoints.every((point, offset) => questionPoints[index + offset] === point) ? [index] : []);
  const start = starts[occurrence];
  if (start === undefined) {throw new Error('benchmark entity occurrence is absent');}
  return { text, start, end: start + textPoints.length };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {return `[${value.map(stableSerialize).join(',')}]`;}
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {return -1;}
  return left > right ? 1 : 0;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    Object.freeze(value);
  }
  return value;
}

if (require.main === module) {
  const loaded = loadWorstCaseBenchmarkDefinitions();
  runWorstCaseBenchmark(loaded.definitions, loaded.definitions_sha256).then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'worst-case benchmark failed'}\n`);
    process.exitCode = 1;
  });
}
