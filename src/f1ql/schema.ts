import { z } from 'zod';
import { F1QLProgram } from './ast';
import { MAX_OFFICIAL_LAP_WINDOW_LAPS, OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID } from './race-season-finishing-position-h2h';
import { QUALIFYING_SEASON_POSITION_H2H_METRIC_ID } from './qualifying-season-position-h2h';
import { DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID, DRIVER_CAREER_WIN_SEASONS } from './driver-career-wins-by-circuit';

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/);
const season = z.number().int().min(1950).max(2100);
const stringOrArray = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const seasonOrArray = z.union([season, z.array(season).min(1)]);
const positions = z.array(z.number().int().min(1).max(30)).min(1).max(30).superRefine((values, context) => {
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'classification positions must be strictly increasing' });
  }
});
const classificationEntityFiltersSchema = z.object({
  classification_status: z.array(z.enum(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn'])).min(1).optional(),
  driver_id: z.string().min(1).optional(),
  team_id: z.string().min(1).optional(),
  finishing_position: positions.optional()
}).strict();

export const standingsFilterSchema = z.object({
  season: seasonOrArray.optional(),
  driver_id: stringOrArray.optional()
}).strict();

export const sourceNodeSchema = z.object({
  op: z.literal('source'),
  source: z.literal('standings')
}).strict();

export const filterNodeSchema = z.object({
  op: z.literal('filter'),
  input: sourceNodeSchema,
  where: standingsFilterSchema
}).strict();

const aggregateMeasureSchema = z.object({
  as: identifier,
  function: z.enum(['sum', 'count', 'min', 'max']),
  field: z.enum(['points', 'championship_position']).optional()
}).strict().superRefine((measure, context) => {
  if (measure.function === 'count' && measure.field !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'count does not accept a field' });
  }
  if (measure.function !== 'count' && measure.field === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${measure.function} requires a field` });
  }
});

export const aggregateNodeSchema = z.object({
  op: z.literal('aggregate'),
  input: z.union([sourceNodeSchema, filterNodeSchema]),
  group_by: z.array(z.literal('driver_id')).min(1).max(1),
  measures: z.array(aggregateMeasureSchema).min(1).max(4)
}).strict().superRefine((node, context) => {
  const aliases = node.measures.map((measure) => measure.as);
  if (new Set(aliases).size !== aliases.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'aggregate aliases must be unique' });
  }
});

export const rankNodeSchema = z.object({
  op: z.literal('rank'),
  input: aggregateNodeSchema,
  by: identifier,
  direction: z.enum(['asc', 'desc']),
  limit: z.number().int().min(1).max(50)
}).strict().superRefine((node, context) => {
  if (!node.input.measures.some((measure) => measure.as === node.by)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'rank field must be an aggregate alias' });
  }
});

export const paceDeltaNodeSchema = z.object({
  op: z.literal('pace_delta'),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1),
  scope: z.object({
    season,
    rounds: z.array(z.number().int().min(1).max(30)).min(1).optional()
  }).strict(),
  filters: z.object({
    clean_air_only: z.boolean().optional(),
    compound: z.string().min(1).optional()
  }).strict().optional()
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pace_delta requires two different drivers' });
  }
});

export const paceSummaryNodeSchema = z.object({
  op: z.literal('pace_summary'),
  driver_id: z.string().min(1),
  scope: z.object({
    season,
    rounds: z.array(z.number().int().min(1).max(30)).min(1).optional()
  }).strict(),
  filters: z.object({
    clean_air_only: z.boolean().optional(),
    compound: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const eventClassificationNodeSchema = z.object({
  op: z.literal('event_classification'),
  season,
  round: z.number().int().min(1).max(30),
  limit: z.number().int().min(1).max(30),
  filters: classificationEntityFiltersSchema.optional()
}).strict().superRefine((node, context) => {
  if (node.filters?.finishing_position !== undefined && node.filters.finishing_position.length !== node.limit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'race position count must equal limit' });
  }
});

export const qualifyingClassificationNodeSchema = z.object({
  op: z.literal('qualifying_classification'),
  season,
  round: z.number().int().min(1).max(30),
  limit: z.number().int().min(1).max(30),
  filters: z.object({
    classification_status: z.array(z.enum(['classified', 'dnf', 'dns'])).min(1).optional(),
    driver_id: z.string().min(1).optional(),
    team_id: z.string().min(1).optional(),
    qualifying_position: positions.optional()
  }).strict().optional()
}).strict().superRefine((node, context) => {
  if (node.filters?.qualifying_position !== undefined && node.filters.qualifying_position.length !== node.limit) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'qualifying position count must equal limit' });
  }
});

export const eventMetadataNodeSchema = z.object({
  op: z.literal('event_metadata'),
  season,
  round: z.number().int().min(1).max(30),
  session_scope: z.enum(['race', 'qualifying']).optional()
}).strict();

export const officialLapWindowMedianCompareNodeSchema = z.object({
  op: z.literal('official_lap_window_median_compare'),
  metric: z.literal(OFFICIAL_LAP_WINDOW_METRIC_ID),
  season,
  round: z.number().int().min(1).max(30),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1),
  lap_start: z.number().int().min(1),
  lap_end: z.number().int().min(1)
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official lap-window comparison requires two different drivers' });
  }
  if (node.lap_end < node.lap_start) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'lap_end must not precede lap_start' });
  } else if (node.lap_end - node.lap_start + 1 > MAX_OFFICIAL_LAP_WINDOW_LAPS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `official lap window may contain at most ${MAX_OFFICIAL_LAP_WINDOW_LAPS} laps` });
  }
});

export const officialEventMeanCompareNodeSchema = z.object({
  op: z.literal('official_event_mean_compare'),
  metric: z.literal(OFFICIAL_EVENT_MEAN_METRIC_ID),
  season,
  round: z.number().int().min(1).max(30),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1)
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official event-mean comparison requires two different drivers' });
  }
});

export const raceSeasonFinishingPositionH2HNodeSchema = z.object({
  op: z.literal('race_season_finishing_position_h2h'),
  metric: z.literal(RACE_SEASON_FINISHING_POSITION_H2H_METRIC_ID),
  season: season.max(2025),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1)
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'race season finishing-position H2H requires two different drivers' });
  }
});

export const qualifyingSeasonPositionH2HNodeSchema = z.object({
  op: z.literal('qualifying_season_position_h2h'),
  metric: z.literal(QUALIFYING_SEASON_POSITION_H2H_METRIC_ID),
  season: season.max(2025),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1)
}).strict().superRefine((node, context) => {
  if (node.driver_a_id === node.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'qualifying season position H2H requires two different drivers' });
  }
});

export const driverCareerWinsByCircuitNodeSchema = z.object({
  op: z.literal('driver_career_wins_by_circuit'),
  metric: z.literal(DRIVER_CAREER_WINS_BY_CIRCUIT_METRIC_ID),
  seasons: z.array(season.max(2025)).length(DRIVER_CAREER_WIN_SEASONS.length),
  driver_id: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/)
}).strict().superRefine((node, context) => {
  if (node.seasons.some((value, index) => value !== DRIVER_CAREER_WIN_SEASONS[index])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'career race-win scope must be the exact ordered 1950-2025 season set' });
  }
});

export const f1qlProgramSchema = z.object({
  version: z.literal(1),
  root: z.union([aggregateNodeSchema, rankNodeSchema, paceDeltaNodeSchema, paceSummaryNodeSchema, eventClassificationNodeSchema, qualifyingClassificationNodeSchema, eventMetadataNodeSchema, officialLapWindowMedianCompareNodeSchema, officialEventMeanCompareNodeSchema, raceSeasonFinishingPositionH2HNodeSchema, qualifyingSeasonPositionH2HNodeSchema, driverCareerWinsByCircuitNodeSchema])
}).strict();

export function parseF1QLProgram(input: unknown): F1QLProgram {
  return f1qlProgramSchema.parse(input) as F1QLProgram;
}
