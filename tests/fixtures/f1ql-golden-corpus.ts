export interface GoldenCorpusCase {
  question: string;
  program: unknown;
  expected?: {
    rejection?: { stage: 'schema' | 'validation' | 'execution'; code?: string; message?: string; options?: { definitionsVersion?: string; maxNodes?: number } };
  };
}

const standings = (question: string, measures: unknown[], where?: Record<string, unknown>, rank?: { by: string; direction: 'asc' | 'desc'; limit: number }): GoldenCorpusCase => ({
  question,
  program: {
    version: 1,
    root: rank
      ? { op: 'rank', input: { op: 'aggregate', input: where ? { op: 'filter', input: { op: 'source', source: 'standings' }, where } : { op: 'source', source: 'standings' }, group_by: ['driver_id'], measures }, ...rank }
      : { op: 'aggregate', input: where ? { op: 'filter', input: { op: 'source', source: 'standings' }, where } : { op: 'source', source: 'standings' }, group_by: ['driver_id'], measures }
  }
});

const paceSummary = (driver_id: string, rounds?: number[], filters?: Record<string, unknown>): GoldenCorpusCase => ({
  question: `${driver_id} pace ${rounds?.join('-') ?? 'season'} ${JSON.stringify(filters ?? {})}`,
  program: { version: 1, root: { op: 'pace_summary', driver_id, scope: { season: 2025, ...(rounds ? { rounds } : {}) }, ...(filters ? { filters } : {}) } }
});

const paceDelta = (driver_a_id: string, driver_b_id: string, rounds?: number[], filters?: Record<string, unknown>): GoldenCorpusCase => ({
  question: `${driver_a_id} versus ${driver_b_id} pace ${rounds?.join('-') ?? 'season'} ${JSON.stringify(filters ?? {})}`,
  program: { version: 1, root: { op: 'pace_delta', driver_a_id, driver_b_id, scope: { season: 2025, ...(rounds ? { rounds } : {}) }, ...(filters ? { filters } : {}) } }
});

const classification = (op: 'event_classification' | 'qualifying_classification', round: number, limit: number, filters?: Record<string, unknown>): GoldenCorpusCase => ({
  question: `${op} round ${round} limit ${limit} ${JSON.stringify(filters ?? {})}`,
  program: { version: 1, root: { op, season: 2025, round, limit, ...(filters ? { filters } : {}) } }
});

const metadata = (round: number, session_scope?: 'race' | 'qualifying'): GoldenCorpusCase => ({
  question: `event metadata round ${round} ${session_scope ?? 'default-race'}`,
  program: { version: 1, root: { op: 'event_metadata', season: 2025, round, ...(session_scope ? { session_scope } : {}) } }
});

export const goldenCorpus: GoldenCorpusCase[] = [
  ...[
    ['standings points', [{ as: 'points', function: 'sum', field: 'points' }]],
    ['standings appearances', [{ as: 'appearances', function: 'count' }]],
    ['standings best position', [{ as: 'best_position', function: 'min', field: 'championship_position' }]],
    ['standings worst position', [{ as: 'worst_position', function: 'max', field: 'championship_position' }]],
    ['standings combined measures', [{ as: 'points', function: 'sum', field: 'points' }, { as: 'appearances', function: 'count' }, { as: 'best_position', function: 'min', field: 'championship_position' }]]
  ].flatMap(([label, measures]) => [
    standings(`${label} 2025`, measures as unknown[], { season: 2025 }),
    standings(`${label} max 2025`, measures as unknown[], { season: 2025, driver_id: 'max-verstappen' }),
    standings(`${label} both drivers 2025`, measures as unknown[], { season: 2025, driver_id: ['max-verstappen', 'lando-norris'] })
  ]),
  standings('rank points descending top one', [{ as: 'points', function: 'sum', field: 'points' }], { season: 2025 }, { by: 'points', direction: 'desc', limit: 1 }),
  standings('rank points descending top two', [{ as: 'points', function: 'sum', field: 'points' }], { season: 2025 }, { by: 'points', direction: 'desc', limit: 2 }),
  standings('rank points ascending', [{ as: 'points', function: 'sum', field: 'points' }], { season: 2025 }, { by: 'points', direction: 'asc', limit: 2 }),
  standings('rank appearances descending', [{ as: 'appearances', function: 'count' }], { season: 2025 }, { by: 'appearances', direction: 'desc', limit: 50 }),
  standings('standings absent season', [{ as: 'points', function: 'sum', field: 'points' }], { season: 2024 }),
  ...[
    ['max-verstappen', undefined, undefined], ['max-verstappen', [1], undefined], ['max-verstappen', [2], undefined], ['max-verstappen', [1, 2], undefined],
    ['max-verstappen', [1, 2], { clean_air_only: true }], ['max-verstappen', [1, 2], { clean_air_only: false }], ['max-verstappen', [1, 2], { compound: 'MEDIUM' }], ['max-verstappen', [1, 2], { compound: 'SOFT' }],
    ['lando-norris', undefined, undefined], ['lando-norris', [1], undefined], ['lando-norris', [2], undefined], ['lando-norris', [1, 2], undefined],
    ['lando-norris', [1, 2], { clean_air_only: true, compound: 'MEDIUM' }], ['lando-norris', [1, 2], { clean_air_only: false, compound: 'MEDIUM' }], ['lando-norris', [3], undefined], ['max-verstappen', [3], { compound: 'MEDIUM' }]
  ].map(([driver, rounds, filters]) => paceSummary(driver as string, rounds as number[] | undefined, filters as Record<string, unknown> | undefined)),
  ...[
    ['max-verstappen', 'lando-norris', undefined, undefined], ['max-verstappen', 'lando-norris', [1], undefined], ['max-verstappen', 'lando-norris', [2], undefined], ['max-verstappen', 'lando-norris', [1, 2], undefined],
    ['max-verstappen', 'lando-norris', [1, 2], { clean_air_only: true }], ['max-verstappen', 'lando-norris', [1, 2], { clean_air_only: false }], ['max-verstappen', 'lando-norris', [1, 2], { compound: 'MEDIUM' }], ['max-verstappen', 'lando-norris', [1, 2], { compound: 'SOFT' }],
    ['lando-norris', 'max-verstappen', [1, 2], { clean_air_only: true, compound: 'MEDIUM' }], ['max-verstappen', 'lando-norris', [3], undefined]
  ].map(([a, b, rounds, filters]) => paceDelta(a as string, b as string, rounds as number[] | undefined, filters as Record<string, unknown> | undefined)),
  ...[
    [1, 1], [1, 2], [1, 10], [2, 10], [1, 10, { classification_status: ['classified'] }], [1, 10, { classification_status: ['dnf'] }], [1, 10, { classification_status: ['dns'] }], [1, 10, { classification_status: ['dsq'] }],
    [1, 10, { classification_status: ['not_classified'] }], [1, 10, { classification_status: ['withdrawn'] }], [1, 10, { driver_id: 'max-verstappen' }], [1, 10, { driver_id: 'lando-norris' }], [1, 10, { team_id: 'red-bull' }], [1, 10, { team_id: 'mclaren' }],
    [1, 10, { classification_status: ['classified'], driver_id: 'max-verstappen', team_id: 'red-bull' }], [1, 10, { classification_status: ['dnf'], driver_id: 'max-verstappen' }]
  ].map(([round, limit, filters]) => classification('event_classification', round as number, limit as number, filters as Record<string, unknown> | undefined)),
  ...[
    [1, 1], [1, 2], [1, 10], [2, 10], [1, 10, { classification_status: ['classified'] }], [1, 10, { classification_status: ['dnf'] }], [1, 10, { classification_status: ['dns'] }],
    [1, 10, { driver_id: 'max-verstappen' }], [1, 10, { driver_id: 'lando-norris' }], [1, 10, { team_id: 'red-bull' }], [1, 10, { team_id: 'mclaren' }], [1, 10, { classification_status: ['classified'], driver_id: 'max-verstappen', team_id: 'red-bull' }],
    [1, 10, { classification_status: ['dns'], team_id: 'mclaren' }], [1, 10, { classification_status: ['dnf'], driver_id: 'max-verstappen' }]
  ].map(([round, limit, filters]) => classification('qualifying_classification', round as number, limit as number, filters as Record<string, unknown> | undefined)),
  ...[1, 2, 30].flatMap(round => [metadata(round), metadata(round, 'race'), metadata(round, 'qualifying')]),
  { question: 'reject event round over schema range', program: { version: 1, root: { op: 'event_metadata', season: 2025, round: 31 } }, expected: { rejection: { stage: 'schema', message: 'Number must be less than or equal to 30' } } },
  { question: 'reject SQL text', program: 'SELECT * FROM laps_normalized', expected: { rejection: { stage: 'schema', message: 'Expected object' } } },
  { question: 'reject pace delta self comparison', program: { version: 1, root: { op: 'pace_delta', driver_a_id: 'max-verstappen', driver_b_id: 'max-verstappen', scope: { season: 2025 } } }, expected: { rejection: { stage: 'schema', message: 'pace_delta requires two different drivers' } } },
  { question: 'reject invalid qualifying status', program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { classification_status: ['dsq'] } } }, expected: { rejection: { stage: 'schema', message: 'Invalid enum value' } } },
  { question: 'reject missing aggregate field', program: { version: 1, root: { op: 'aggregate', input: { op: 'source', source: 'standings' }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum' }] } }, expected: { rejection: { stage: 'schema', message: 'sum requires a field' } } },
  { question: 'reject count field', program: { version: 1, root: { op: 'aggregate', input: { op: 'source', source: 'standings' }, group_by: ['driver_id'], measures: [{ as: 'count', function: 'count', field: 'points' }] } }, expected: { rejection: { stage: 'schema', message: 'count does not accept a field' } } },
  { question: 'reject invalid rank alias', program: { version: 1, root: { op: 'rank', input: { op: 'aggregate', input: { op: 'source', source: 'standings' }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] }, by: 'missing', direction: 'desc', limit: 1 } }, expected: { rejection: { stage: 'schema', message: 'rank field must be an aggregate alias' } } },
  { question: 'reject pace round over schema range', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025, rounds: [31] } } }, expected: { rejection: { stage: 'schema', message: 'Number must be less than or equal to 30' } } },
  { question: 'reject event limit over schema range', program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 31 } }, expected: { rejection: { stage: 'schema', message: 'Number must be less than or equal to 30' } } },
  { question: 'reject pace round cost budget', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025, rounds: Array.from({ length: 25 }, (_, index) => index + 1) } } }, expected: { rejection: { stage: 'execution', message: 'At most 24 rounds may be requested' } } },
  { question: 'reject missing pace participant', program: { version: 1, root: { op: 'pace_summary', driver_id: 'unknown-driver', scope: { season: 2025 } } }, expected: { rejection: { stage: 'execution', code: 'participation_missing' } } },
  { question: 'reject inactive definitions', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } }, expected: { rejection: { stage: 'validation', code: 'definitions_version_mismatch', options: { definitionsVersion: 'inactive' } } } },
  { question: 'reject complexity budget', program: { version: 1, root: { op: 'pace_summary', driver_id: 'max-verstappen', scope: { season: 2025 } } }, expected: { rejection: { stage: 'validation', code: 'complexity_exceeded', options: { maxNodes: 0 } } } },
  { question: 'reject unsupported raw source', program: { version: 1, root: { op: 'aggregate', input: { op: 'source', source: 'lap_pace' }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] } }, expected: { rejection: { stage: 'validation', code: 'coverage_unsupported' } } },
  { question: 'reject invalid raw standings field', program: { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025, team_id: 'red-bull' } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] } }, expected: { rejection: { stage: 'validation', code: 'signature_invalid' } } }
];

if (goldenCorpus.length !== 100) {
  throw new Error(`Golden corpus must contain 100 cases; found ${goldenCorpus.length}`);
}
