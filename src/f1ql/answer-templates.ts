import { createHash } from 'crypto';
import { z } from 'zod';
import { F1QLProgram } from './ast';
import { normalizeF1QLProgram } from './verified-programs';

export const ANSWER_TEMPLATE_REGISTRY_VERSION = 'answer-templates-v5' as const;
export const ANSWER_ALL_CLASSIFICATION_MIN_SEASON = 1996;
export const ANSWER_ALL_CLASSIFICATION_MAX_SEASON = 2026;
const SEASON_MIN = 1950;
const SEASON_MAX = 2100;
const FINAL_SEASON_MAX = 2025;
const CURRENT_STANDINGS_SEASON = 2026;
const ROUND_MIN = 1;
const ROUND_MAX = 30;
const DRIVER_ID_MAX_LENGTH = 100;
const DRIVER_ID_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const RACE_STATUSES = ['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'] as const;
const QUALIFYING_STATUSES = ['classified', 'dnf', 'dns'] as const;

export type AnswerTemplateId =
  | 'final_standings_points' | 'final_standings_leader' | 'current_standings'
  | 'driver_season_official_summary'
  | 'race_classification_all' | 'race_classification_driver' | 'race_classification_status'
  | 'qualifying_classification_all' | 'qualifying_classification_driver' | 'qualifying_classification_status'
  | 'race_classification_position' | 'qualifying_classification_position'
  | 'race_date';

const season = z.number().int().min(SEASON_MIN).max(SEASON_MAX);
const finalSeason = z.number().int().min(SEASON_MIN).max(FINAL_SEASON_MAX);
const currentStandingsSeason = z.literal(CURRENT_STANDINGS_SEASON);
const allClassificationSeason = z.number().int().min(ANSWER_ALL_CLASSIFICATION_MIN_SEASON).max(ANSWER_ALL_CLASSIFICATION_MAX_SEASON);
const round = z.number().int().min(ROUND_MIN).max(ROUND_MAX);
const resolvedDriverId = z.string().regex(new RegExp(DRIVER_ID_PATTERN)).max(DRIVER_ID_MAX_LENGTH);
const raceStatus = z.enum(RACE_STATUSES);
const qualifyingStatus = z.enum(QUALIFYING_STATUSES);
const positions = z.array(z.number().int().min(1).max(30)).min(1).max(30).superRefine((values, context) => {
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Positions must be strictly increasing' });
  }
});

const seasonConstraint = { type: 'integer', minimum: SEASON_MIN, maximum: SEASON_MAX } as const;
const finalSeasonConstraint = { type: 'integer', minimum: SEASON_MIN, maximum: FINAL_SEASON_MAX } as const;
const currentStandingsSeasonConstraint = { type: 'integer', minimum: CURRENT_STANDINGS_SEASON, maximum: CURRENT_STANDINGS_SEASON } as const;
const allClassificationSeasonConstraint = { type: 'integer', minimum: ANSWER_ALL_CLASSIFICATION_MIN_SEASON, maximum: ANSWER_ALL_CLASSIFICATION_MAX_SEASON } as const;
const roundConstraint = { type: 'integer', minimum: ROUND_MIN, maximum: ROUND_MAX } as const;
const driverIdConstraint = { type: 'string', pattern: DRIVER_ID_PATTERN, max_length: DRIVER_ID_MAX_LENGTH } as const;

export const ANSWER_TEMPLATE_REGISTRY_CONTRACT = deepFreeze({
  final_standings_points: {
    variables: { season: finalSeasonConstraint, driver_ids: { type: 'array', item: driverIdConstraint, minimum_items: 1, maximum_items: 4, unique: true, optional: true } },
    semantic: 'standings filtered to one final season and optional driver set; max points grouped by driver_id'
  },
  final_standings_leader: {
    variables: { season: finalSeasonConstraint },
    semantic: 'standings filtered to one final season; min official championship_position and max points grouped by driver_id; ascending official position limit 1'
  },
  current_standings: {
    variables: { season: currentStandingsSeasonConstraint },
    semantic: 'latest recorded standings snapshot for the reviewed ongoing season; min official championship_position and max points grouped by driver_id; ascending official position limit 30'
  },
  driver_season_official_summary: {
    variables: { season: finalSeasonConstraint, driver_id: driverIdConstraint },
    semantic: 'one final-season recorded championship position and points row for one canonical driver; count source rows for integrity'
  },
  race_classification_all: {
    variables: { season: allClassificationSeasonConstraint, round: roundConstraint },
    semantic: 'race event classification for one event; no entity filter; fixed limit 30'
  },
  race_classification_driver: {
    variables: { season: seasonConstraint, round: roundConstraint, driver_id: driverIdConstraint },
    semantic: 'race event classification for one event and one canonical driver; fixed limit 30'
  },
  race_classification_status: {
    variables: { season: seasonConstraint, round: roundConstraint, status: { type: 'enum', values: RACE_STATUSES } },
    semantic: 'race event classification for one event and one classification status; fixed limit 30'
  },
  qualifying_classification_all: {
    variables: { season: allClassificationSeasonConstraint, round: roundConstraint },
    semantic: 'qualifying classification for one event; no entity filter; fixed limit 30'
  },
  qualifying_classification_driver: {
    variables: { season: seasonConstraint, round: roundConstraint, driver_id: driverIdConstraint },
    semantic: 'qualifying classification for one event and one canonical driver; fixed limit 30'
  },
  qualifying_classification_status: {
    variables: { season: seasonConstraint, round: roundConstraint, status: { type: 'enum', values: QUALIFYING_STATUSES } },
    semantic: 'qualifying classification for one event and one classification status; fixed limit 30'
  },
  race_classification_position: {
    variables: { season: seasonConstraint, round: roundConstraint, positions: { type: 'array', item: { type: 'integer', minimum: 1, maximum: 30 }, minimum_items: 1, maximum_items: 30, unique: true, order: 'strictly_increasing' } },
    semantic: 'race event classification for one event and exact numbered finishing positions; limit equals position count'
  },
  qualifying_classification_position: {
    variables: { season: seasonConstraint, round: roundConstraint, positions: { type: 'array', item: { type: 'integer', minimum: 1, maximum: 30 }, minimum_items: 1, maximum_items: 30, unique: true, order: 'strictly_increasing' } },
    semantic: 'qualifying classification for one event and exact numbered qualifying positions; limit equals position count'
  },
  race_date: {
    variables: { season: seasonConstraint, round: roundConstraint },
    semantic: 'event metadata for one event with race session scope'
  }
} satisfies Record<AnswerTemplateId, { variables: object; semantic: string }>);

const variableSchemas = {
  final_standings_points: z.object({ season: finalSeason, driver_ids: z.array(resolvedDriverId).min(1).max(4).refine(ids => new Set(ids).size === ids.length, 'Resolved driver IDs must be unique').optional() }).strict(),
  final_standings_leader: z.object({ season: finalSeason }).strict(),
  current_standings: z.object({ season: currentStandingsSeason }).strict(),
  driver_season_official_summary: z.object({ season: finalSeason, driver_id: resolvedDriverId }).strict(),
  race_classification_all: z.object({ season: allClassificationSeason, round }).strict(),
  race_classification_driver: z.object({ season, round, driver_id: resolvedDriverId }).strict(),
  race_classification_status: z.object({ season, round, status: raceStatus }).strict(),
  qualifying_classification_all: z.object({ season: allClassificationSeason, round }).strict(),
  qualifying_classification_driver: z.object({ season, round, driver_id: resolvedDriverId }).strict(),
  qualifying_classification_status: z.object({ season, round, status: qualifyingStatus }).strict(),
  race_classification_position: z.object({ season, round, positions }).strict(),
  qualifying_classification_position: z.object({ season, round, positions }).strict(),
  race_date: z.object({ season, round }).strict()
} satisfies Record<AnswerTemplateId, z.ZodTypeAny>;

export const ANSWER_TEMPLATE_IDS = Object.freeze(Object.keys(variableSchemas).sort() as AnswerTemplateId[]);
export const ANSWER_TEMPLATE_REGISTRY = deepFreeze({
  version: ANSWER_TEMPLATE_REGISTRY_VERSION,
  template_ids: ANSWER_TEMPLATE_IDS,
  contracts: ANSWER_TEMPLATE_REGISTRY_CONTRACT
});

interface ScopedVariables {
  season: number;
  round?: number;
  driver_id?: string;
  driver_ids?: string[];
  status?: string;
  positions?: number[];
}

export type AnswerTemplateVariables = Readonly<Record<string, unknown>>;

export function validateAnswerTemplateVariables(templateId: AnswerTemplateId, variables: unknown): AnswerTemplateVariables {
  if (!Object.prototype.hasOwnProperty.call(variableSchemas, templateId)) {
    throw new Error('Unknown answer template');
  }
  return deepFreeze(variableSchemas[templateId].parse(variables) as Record<string, unknown>);
}

export function materializeAnswerTemplate(templateId: AnswerTemplateId, variables: unknown): F1QLProgram {
  const parsed = validateAnswerTemplateVariables(templateId, variables);
  const scoped = parsed as unknown as ScopedVariables;
  let root: F1QLProgram['root'];

  if (templateId === 'final_standings_points') {
    root = {
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: scoped.season, ...(scoped.driver_ids ? { driver_id: scoped.driver_ids } : {}) } },
      group_by: ['driver_id'],
      measures: [{ as: 'points', function: 'max', field: 'points' }]
    };
  } else if (templateId === 'driver_season_official_summary') {
    root = {
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: scoped.season, driver_id: scoped.driver_id as string } },
      group_by: ['driver_id'],
      measures: [
        { as: 'championship_position', function: 'min', field: 'championship_position' },
        { as: 'points', function: 'max', field: 'points' },
        { as: 'standing_rows', function: 'count' }
      ]
    };
  } else if (templateId === 'final_standings_leader' || templateId === 'current_standings') {
    root = {
      op: 'rank',
      input: {
        op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: scoped.season } }, group_by: ['driver_id'],
        measures: [{ as: 'championship_position', function: 'min', field: 'championship_position' }, { as: 'points', function: 'max', field: 'points' }]
      },
      by: 'championship_position', direction: 'asc', limit: templateId === 'current_standings' ? 30 : 1
    };
  } else if (templateId === 'race_date') {
    root = { op: 'event_metadata', season: scoped.season, round: scoped.round as number, session_scope: 'race' };
  } else if (templateId === 'race_classification_position') {
    root = { op: 'event_classification', season: scoped.season, round: scoped.round as number, limit: scoped.positions?.length as number, filters: { finishing_position: scoped.positions as number[] } };
  } else if (templateId === 'qualifying_classification_position') {
    root = { op: 'qualifying_classification', season: scoped.season, round: scoped.round as number, limit: scoped.positions?.length as number, filters: { qualifying_position: scoped.positions as number[] } };
  } else if (templateId.startsWith('race_classification')) {
    const filters = classificationFilters(scoped) as Extract<F1QLProgram['root'], { op: 'event_classification' }>['filters'];
    root = {
      op: 'event_classification', season: scoped.season, round: scoped.round as number, limit: 30,
      ...(filters ? { filters } : {})
    };
  } else {
    const filters = classificationFilters(scoped) as Extract<F1QLProgram['root'], { op: 'qualifying_classification' }>['filters'];
    root = {
      op: 'qualifying_classification', season: scoped.season, round: scoped.round as number, limit: 30,
      ...(filters ? { filters } : {})
    };
  }
  return deepFreeze(normalizeF1QLProgram({ version: 1, root }));
}

type AnswerTemplateMaterializer = (templateId: AnswerTemplateId, variables: unknown) => F1QLProgram;

const templateSentinels: Readonly<Record<AnswerTemplateId, readonly unknown[]>> = Object.freeze({
  final_standings_points: [{ season: 2025 }, { season: 2025, driver_ids: ['sentinel-driver', 'second-driver'] }],
  final_standings_leader: [{ season: 2025 }],
  current_standings: [{ season: CURRENT_STANDINGS_SEASON }],
  driver_season_official_summary: [{ season: 2025, driver_id: 'sentinel-driver' }],
  race_classification_all: [{ season: 2025, round: 7 }],
  race_classification_driver: [{ season: 2025, round: 7, driver_id: 'sentinel-driver' }],
  race_classification_status: [{ season: 2025, round: 7, status: 'dsq' }],
  qualifying_classification_all: [{ season: 2025, round: 7 }],
  qualifying_classification_driver: [{ season: 2025, round: 7, driver_id: 'sentinel-driver' }],
  qualifying_classification_status: [{ season: 2025, round: 7, status: 'dns' }],
  race_classification_position: [{ season: 2025, round: 7, positions: [1] }, { season: 2025, round: 7, positions: [1, 2, 3] }, { season: 2025, round: 7, positions: [2] }],
  qualifying_classification_position: [{ season: 2025, round: 7, positions: [1] }, { season: 2025, round: 7, positions: [1, 2, 3, 4, 5] }, { season: 2025, round: 7, positions: [3] }],
  race_date: [{ season: 2025, round: 7 }]
});

export function computeAnswerTemplateRegistryHash(
  materialize: AnswerTemplateMaterializer = materializeAnswerTemplate,
  contracts: unknown = ANSWER_TEMPLATE_REGISTRY_CONTRACT
): string {
  const semantics = ANSWER_TEMPLATE_IDS.map(templateId => ({
    template_id: templateId,
    programs: templateSentinels[templateId].map(variables => materialize(templateId, variables))
  }));
  return createHash('sha256').update(stableSerialize({
    registry: { version: ANSWER_TEMPLATE_REGISTRY_VERSION, template_ids: ANSWER_TEMPLATE_IDS, contracts },
    semantics
  })).digest('hex');
}

export const ANSWER_TEMPLATE_REGISTRY_HASH = computeAnswerTemplateRegistryHash();

function classificationFilters(scoped: ScopedVariables): { driver_id: string } | { classification_status: string[] } | undefined {
  if (scoped.driver_id) {
    return { driver_id: scoped.driver_id };
  }
  return scoped.status ? { classification_status: [scoped.status] } : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
