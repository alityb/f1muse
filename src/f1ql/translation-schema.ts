import { z } from 'zod';
import { F1QLProgram } from './ast';
import { MAX_OFFICIAL_LAP_WINDOW_LAPS, OFFICIAL_LAP_WINDOW_METRIC_ID } from './official-lap-window';
import { OFFICIAL_EVENT_MEAN_METRIC_ID } from './official-event-mean';
import { f1qlProgramSchema } from './schema';

const season = z.number().int().min(1950).max(2100);
const classificationStatus = z.enum(['classified', 'dnf', 'dns', 'dsq', 'not_classified', 'withdrawn']);
const namedEventRootSchema = z.object({
  op: z.enum(['event_classification', 'qualifying_classification', 'event_metadata']),
  season,
  event_name: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(30).optional(),
  session_scope: z.enum(['race', 'qualifying']).optional(),
  filters: z.object({
    classification_status: z.array(classificationStatus).min(1).optional(),
    driver_id: z.string().min(1).optional(),
    team_id: z.string().min(1).optional()
  }).strict().optional()
}).strict().superRefine((root, context) => {
  if (root.op === 'event_metadata' && (root.limit !== undefined || root.filters !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'event_metadata does not accept limit or filters' });
  }
  if (root.op !== 'event_metadata' && (root.limit === undefined || root.session_scope !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'classification requires limit and does not accept session_scope' });
  }
  if (root.op === 'qualifying_classification' && root.filters?.classification_status?.some(status => !['classified', 'dnf', 'dns'].includes(status))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'unsupported qualifying classification status' });
  }
});

const namedOfficialLapWindowRootSchema = z.object({
  op: z.literal('official_lap_window_median_compare'),
  metric: z.literal(OFFICIAL_LAP_WINDOW_METRIC_ID),
  season,
  event_name: z.string().min(1).max(200),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1),
  lap_start: z.number().int().min(1),
  lap_end: z.number().int().min(1)
}).strict().superRefine((root, context) => {
  if (root.driver_a_id === root.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official lap-window comparison requires two different driver references' });
  }
  if (root.lap_end < root.lap_start) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'lap_end must not precede lap_start' });
  } else if (root.lap_end - root.lap_start + 1 > MAX_OFFICIAL_LAP_WINDOW_LAPS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `official lap window may contain at most ${MAX_OFFICIAL_LAP_WINDOW_LAPS} laps` });
  }
});

const namedOfficialEventMeanRootSchema = z.object({
  op: z.literal('official_event_mean_compare'),
  metric: z.literal(OFFICIAL_EVENT_MEAN_METRIC_ID),
  season,
  event_name: z.string().min(1).max(200),
  driver_a_id: z.string().min(1),
  driver_b_id: z.string().min(1)
}).strict().superRefine((root, context) => {
  if (root.driver_a_id === root.driver_b_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'official event-mean comparison requires two different driver references' });
  }
});

const namedEventProgramSchema = z.object({
  version: z.literal(1),
  root: z.union([namedEventRootSchema, namedOfficialLapWindowRootSchema, namedOfficialEventMeanRootSchema])
}).strict();

export type NamedEventProgramCandidate = z.infer<typeof namedEventProgramSchema>;
export type F1QLProgramCandidate = F1QLProgram | NamedEventProgramCandidate;

export function parseF1QLProgramCandidate(input: unknown): F1QLProgramCandidate {
  const canonical = f1qlProgramSchema.safeParse(input);
  return canonical.success && canonical.data.root.op !== 'race_season_finishing_position_h2h'
    ? canonical.data as F1QLProgram
    : namedEventProgramSchema.parse(input);
}

export function isNamedEventProgram(candidate: F1QLProgramCandidate): candidate is NamedEventProgramCandidate {
  return 'event_name' in candidate.root;
}
