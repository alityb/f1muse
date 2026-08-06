import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  compilePlannedF1QL,
  compilePlannedF1QLResultCollection,
  PLANNED_INTEGRITY_FIELD
} from '../../src/f1ql/planned-compiler';
import {
  decidePlannedParticipation,
  estimatePlannedF1QLCost,
  getPlannedCoreProgramHash,
  getPlannedF1QLProgramHash,
  lowerPlannedF1QL,
  parsePlannedF1QLProgram,
  validatePlannedCoreProgram
} from '../../src/f1ql/planned-f1ql';
import { interpretPlannedF1QL, PlannedReferenceDatabase } from '../../src/f1ql/planned-interpreter';
import { preparePlannedF1QLParent, verifyPlannedF1QLParent } from '../../src/f1ql/planned-pipeline';
import { parseF1QLProgram } from '../../src/f1ql/schema';
import { SEMANTIC_CATALOG_HASH } from '../../src/f1ql/semantic-catalog';
import { getTestDatabaseUrl, setupTestDatabase } from '../../src/test/setup';

let pool: Pool;

const ref = (source_id: string, concept_id: string) => ({ source_id, concept_id });
const predicate = (source_id: string, concept_id: string, value: string | number) => ({
  concept: ref(source_id, concept_id), operator: 'eq', value
});

function qualifyingRankPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort',
        keys: [
          { output_id: 'count_qualifying_position', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: 'qualifying_classification' },
              predicates: [
                { concept: ref('qualifying_classification', 'qualifying_position'), operator: 'range', min: 1, max: 10 },
                predicate('qualifying_classification', 'season', 2025)
              ]
            },
            group_by: [ref('qualifying_classification', 'driver_id')],
            measures: [{ concept: ref('qualifying_classification', 'qualifying_position'), function: 'count', as: 'count_qualifying_position' }]
          },
          outputs: [
            { kind: 'concept', concept: ref('qualifying_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'aggregate', measure_as: 'count_qualifying_position', as: 'count_qualifying_position' }
          ]
        }
      }
    }
  };
}

function raceMetadataPlan() {
  const raceScope = [
    predicate('event_classification', 'round', 1),
    predicate('event_classification', 'season', 2025)
  ];
  const metadataScope = [
    predicate('event_metadata', 'round', 1),
    predicate('event_metadata', 'season', 2025)
  ];
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 30,
      input: {
        op: 'sort',
        keys: [
          { output_id: 'finishing_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'join', relationship_id: 'race_event_metadata',
            left: { op: 'filter', input: { op: 'source', source_id: 'event_classification' }, predicates: raceScope },
            right: { op: 'filter', input: { op: 'source', source_id: 'event_metadata' }, predicates: metadataScope }
          },
          outputs: [
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('event_classification', 'finishing_position'), as: 'finishing_position' },
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'circuit_id'), as: 'circuit_id' }
          ]
        }
      }
    }
  };
}

function selectedRaceMetadataPlan(driverIds: string | readonly string[]) {
  const selected = typeof driverIds === 'string' ? [driverIds] : [...driverIds];
  const multi = selected.length > 1;
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: multi ? 100 : 1,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'join', relationship_id: 'race_event_metadata',
            left: {
              op: 'filter', input: { op: 'source', source_id: 'event_classification' },
              predicates: [
                multi
                  ? { concept: ref('event_classification', 'driver_id'), operator: 'in', values: selected }
                  : predicate('event_classification', 'driver_id', selected[0]),
                predicate('event_classification', 'round', 1),
                predicate('event_classification', 'season', 2025)
              ]
            },
            right: {
              op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
              predicates: [
                predicate('event_metadata', 'round', 1),
                predicate('event_metadata', 'season', 2025)
              ]
            }
          },
          outputs: [
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('event_classification', 'finishing_position'), as: 'finishing_position' },
            { kind: 'concept', concept: ref('event_metadata', 'date'), as: 'date' },
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'circuit_id'), as: 'circuit_id' }
          ]
        }
      }
    }
  };
}

function selectedQualifyingMetadataPlan(driverIds: string | readonly string[]) {
  const selected = typeof driverIds === 'string' ? [driverIds] : [...driverIds];
  const multi = selected.length > 1;
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: multi ? 100 : 1,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'join', relationship_id: 'qualifying_event_metadata',
            left: {
              op: 'filter', input: { op: 'source', source_id: 'qualifying_classification' },
              predicates: [
                multi
                  ? { concept: ref('qualifying_classification', 'driver_id'), operator: 'in', values: selected }
                  : predicate('qualifying_classification', 'driver_id', selected[0]),
                predicate('qualifying_classification', 'round', 1),
                predicate('qualifying_classification', 'season', 2025)
              ]
            },
            right: {
              op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
              predicates: [
                predicate('event_metadata', 'round', 1),
                predicate('event_metadata', 'season', 2025)
              ]
            }
          },
          outputs: [
            { kind: 'concept', concept: ref('qualifying_classification', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('qualifying_classification', 'qualifying_position'), as: 'qualifying_position' },
            { kind: 'concept', concept: ref('event_metadata', 'date'), as: 'date' },
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'circuit_id'), as: 'circuit_id' }
          ]
        }
      }
    }
  };
}

function standingsRankPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 2,
      input: {
        op: 'sort', keys: [
          { output_id: 'min_championship_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
              predicates: [
                { concept: ref('driver_standings', 'driver_id'), operator: 'in', values: ['alpha-driver', 'beta-driver'] },
                predicate('driver_standings', 'season', 2025)
              ]
            },
            group_by: [ref('driver_standings', 'driver_id')],
            measures: [{ concept: ref('driver_standings', 'championship_position'), function: 'min', as: 'min_championship_position' }]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'aggregate', measure_as: 'min_championship_position', as: 'min_championship_position' }
          ]
        }
      }
    }
  };
}

function selectedStandingsPositionRankPlan(driverIds = ['alpha-driver', 'beta-driver']) {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 100,
      input: {
        op: 'sort', keys: [
          { output_id: 'championship_position', direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
            predicates: [
              { concept: ref('driver_standings', 'driver_id'), operator: 'in', values: driverIds },
              predicate('driver_standings', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('driver_standings', 'championship_position'), as: 'championship_position' }
          ]
        }
      }
    }
  };
}

function selectedStandingsPositionPlan(driverId = 'alpha-driver') {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
            predicates: [
              predicate('driver_standings', 'driver_id', driverId),
              predicate('driver_standings', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('driver_standings', 'championship_position'), as: 'championship_position' }
          ]
        }
      }
    }
  };
}

function selectedStandingsSummaryPlan(driverIds: string | string[] = 'alpha-driver') {
  const selectedDriverIds = Array.isArray(driverIds) ? driverIds : [driverIds];
  const multiDriver = selectedDriverIds.length > 1;
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: multiDriver ? 100 : 1,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
            predicates: [
              multiDriver
                ? { concept: ref('driver_standings', 'driver_id'), operator: 'in', values: selectedDriverIds }
                : predicate('driver_standings', 'driver_id', selectedDriverIds[0]),
              predicate('driver_standings', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('driver_standings', 'championship_position'), as: 'championship_position' },
            { kind: 'concept', concept: ref('driver_standings', 'points'), as: 'points' }
          ]
        }
      }
    }
  };
}

function selectedStandingsPositionsPlan(driverIds = ['alpha-driver', 'beta-driver']) {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 100,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
            predicates: [
              { concept: ref('driver_standings', 'driver_id'), operator: 'in', values: driverIds },
              predicate('driver_standings', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('driver_standings', 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref('driver_standings', 'championship_position'), as: 'championship_position' }
          ]
        }
      }
    }
  };
}

function eventMetadataRowsPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'event_name', direction: 'desc', nulls: 'last' },
          { output_id: 'round', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'season', 2025)]
          },
          outputs: [
            { kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' },
            { kind: 'concept', concept: ref('event_metadata', 'round'), as: 'round' }
          ]
        }
      }
    }
  };
}

function eventDatePlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: 'date', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'round', 1), predicate('event_metadata', 'season', 2025)]
          },
          outputs: [{ kind: 'concept', concept: ref('event_metadata', 'date'), as: 'date' }]
        }
      }
    }
  };
}

function eventDateNamePlan(round = 1) {
  return eventMetadataProjectionPlan(['date', 'event_name'], round);
}

function eventMetadataProjectionPlan(
  conceptIds: readonly ('circuit_id' | 'date' | 'event_name')[],
  round = 1
) {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: conceptIds[0], direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'round', round), predicate('event_metadata', 'season', 2025)]
          },
          outputs: conceptIds.map(conceptId => ({
            kind: 'concept', concept: ref('event_metadata', conceptId), as: conceptId
          }))
        }
      }
    }
  };
}

function eventCircuitPlan(round = 1) {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: 'circuit_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'round', round), predicate('event_metadata', 'season', 2025)]
          },
          outputs: [{ kind: 'concept', concept: ref('event_metadata', 'circuit_id'), as: 'circuit_id' }]
        }
      }
    }
  };
}

function eventNamePlan(round = 1) {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: 'event_name', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_metadata' },
            predicates: [predicate('event_metadata', 'round', round), predicate('event_metadata', 'season', 2025)]
          },
          outputs: [{ kind: 'concept', concept: ref('event_metadata', 'event_name'), as: 'event_name' }]
        }
      }
    }
  };
}

function scalarClassificationCountPlan(
  sourceId: 'event_classification' | 'qualifying_classification',
  classificationStatus?: 'dns',
  driverId?: string
) {
  const positionId = sourceId === 'event_classification' ? 'finishing_position' : 'qualifying_position';
  const countId = `count_${positionId}`;
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort', keys: [{ output_id: countId, direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'aggregate',
            input: {
              op: 'filter', input: { op: 'source', source_id: sourceId },
              predicates: [
                ...(driverId === undefined ? [] : [predicate(sourceId, 'driver_id', driverId)]),
                ...(classificationStatus === undefined ? [] : [
                  predicate(sourceId, 'classification_status', classificationStatus)
                ]),
                predicate(sourceId, 'season', 2025)
              ]
            },
            group_by: [],
            measures: [{ concept: ref(sourceId, positionId), function: 'count', as: countId }]
          },
          outputs: [{ kind: 'aggregate', measure_as: countId, as: countId }]
        }
      }
    }
  };
}

function scalarQualifyingCountPlan(classificationStatus?: 'dns', driverId?: string) {
  return scalarClassificationCountPlan('qualifying_classification', classificationStatus, driverId);
}

function scalarRaceCountPlan(driverId?: string) {
  return scalarClassificationCountPlan('event_classification', undefined, driverId);
}

function eventPointsPlan() {
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 10,
      input: {
        op: 'sort', keys: [
          { output_id: 'points', direction: 'desc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: 'event_classification' },
            predicates: [
              predicate('event_classification', 'round', 1),
              predicate('event_classification', 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref('event_classification', 'points'), as: 'points' },
            { kind: 'concept', concept: ref('event_classification', 'driver_id'), as: 'driver_id' }
          ]
        }
      }
    }
  };
}

function classificationSelectionPlan(
  sourceId: 'event_classification' | 'qualifying_classification',
  driverIds: readonly string[] = []
) {
  const positionId = sourceId === 'event_classification' ? 'finishing_position' : 'qualifying_position';
  const driverPredicate = driverIds.length === 0 ? [] : [{
    concept: ref(sourceId, 'driver_id'),
    ...(driverIds.length === 1
      ? { operator: 'eq' as const, value: driverIds[0] }
      : { operator: 'in' as const, values: [...driverIds] })
  }];
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: driverIds.length === 1 ? 1 : 100,
      input: {
        op: 'sort', keys: [{ output_id: 'driver_id', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: sourceId },
            predicates: [
              ...driverPredicate,
              predicate(sourceId, 'round', 1),
              predicate(sourceId, 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref(sourceId, 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref(sourceId, positionId), as: positionId }
          ]
        }
      }
    }
  };
}

function selectedClassificationPositionRankPlan(
  sourceId: 'event_classification' | 'qualifying_classification',
  driverIds = ['alpha-driver', 'beta-driver']
) {
  const positionId = sourceId === 'event_classification' ? 'finishing_position' : 'qualifying_position';
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 100,
      input: {
        op: 'sort', keys: [
          { output_id: positionId, direction: 'asc', nulls: 'last' },
          { output_id: 'driver_id', direction: 'asc', nulls: 'last' }
        ],
        input: {
          op: 'project',
          input: {
            op: 'filter', input: { op: 'source', source_id: sourceId },
            predicates: [
              { concept: ref(sourceId, 'driver_id'), operator: 'in', values: driverIds },
              predicate(sourceId, 'round', 1),
              predicate(sourceId, 'season', 2025)
            ]
          },
          outputs: [
            { kind: 'concept', concept: ref(sourceId, 'driver_id'), as: 'driver_id' },
            { kind: 'concept', concept: ref(sourceId, positionId), as: positionId }
          ]
        }
      }
    }
  };
}

function scalarCompositionPlan() {
  const aggregate = (sourceId: 'event_classification' | 'qualifying_classification', driverId: string) => {
    const conceptId = sourceId === 'event_classification' ? 'finishing_position' : 'qualifying_position';
    return {
      op: 'aggregate',
      input: {
        op: 'filter', input: { op: 'source', source_id: sourceId },
        predicates: [predicate(sourceId, 'driver_id', driverId), predicate(sourceId, 'season', 2025)]
      },
      group_by: [],
      measures: [{ concept: ref(sourceId, conceptId), function: 'count', as: `count_${conceptId}` }]
    };
  };
  return {
    kind: 'internal_planned_f1ql', version: 2, catalog_hash: SEMANTIC_CATALOG_HASH,
    root: {
      op: 'limit', count: 1,
      input: {
        op: 'sort',
        keys: [{ output_id: 'event_classification__count_finishing_position', direction: 'asc', nulls: 'last' }],
        input: {
          op: 'project',
          input: {
            op: 'compose',
            inputs: [aggregate('event_classification', 'alpha-driver'), aggregate('qualifying_classification', 'beta-driver')]
          },
          outputs: [
            {
              kind: 'composed_aggregate', source_id: 'event_classification',
              measure_as: 'count_finishing_position', as: 'event_classification__count_finishing_position'
            },
            {
              kind: 'composed_aggregate', source_id: 'qualifying_classification',
              measure_as: 'count_qualifying_position', as: 'qualifying_classification__count_qualifying_position'
            }
          ]
        }
      }
    }
  };
}

describe('internal planned F1QL and Core pipeline', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await setupTestDatabase(pool, { seed: false });
    await pool.query(`
      INSERT INTO driver (id, name, full_name, abbreviation) VALUES
        ('alpha_driver', 'Alpha', 'Alpha Driver', 'ALP'), ('beta_driver', 'Beta', 'Beta Driver', 'BET');
      INSERT INTO grand_prix (id, name, full_name, short_name, abbreviation) VALUES
        ('planned_gp', 'Planned GP', 'Formula 1 Planned Grand Prix', 'Planned', 'PLN'),
        ('unicode_gp', 'Unicode GP', chr(201) || 'clair Grand Prix', 'Unicode', 'UNI');
      INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES
          (9801, 2025, 1, 'planned_gp', 'planned-circuit', 'FORMULA 1 PLANNED GRAND PRIX', '2025-01-01'),
          (9802, 2025, 2, NULL, 'empty-circuit', NULL, '2025-02-01'),
          (9803, 2025, 3, 'unicode_gp', 'unicode-circuit', NULL, '2025-03-01');
      INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points) VALUES
        (9801, 'race', 'beta_driver', 'planned-team', 2, 2, 9007199254740992),
        (9801, 'race', 'alpha_driver', 'planned-team', 1, 1, 9007199254740993);
      INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type) VALUES
        (2025, 1, 'beta_driver', 'planned-team', 2, 'RACE_QUALIFYING'),
        (2025, 1, 'alpha_driver', 'planned-team', 1, 'RACE_QUALIFYING'),
        (2025, 2, 'outside_driver', 'planned-team', 11, 'RACE_QUALIFYING');
      INSERT INTO season_driver_standing
        (year, position_display_order, position_number, driver_id, points, championship_won) VALUES
        (2025, 1, 1, 'alpha_driver', 100, true),
        (2025, 2, 2, 'beta_driver', 90, false),
        (2025, 3, 3, 'outside_driver', 80, false);
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('strictly parses, freezes, hashes, costs, and derives participation for promoted plans', () => {
    const ranking = parsePlannedF1QLProgram(qualifyingRankPlan());
    expect(Object.isFrozen(ranking)).toBe(true);
    expect(Object.isFrozen(ranking.root.input.keys)).toBe(true);
    expect(getPlannedF1QLProgramHash(ranking)).toMatch(/^[a-f0-9]{64}$/);
    expect(estimatePlannedF1QLCost(ranking)).toEqual({
      version: 'planned-cost-v1', units: 30, sources: 1, joins: 0, depth: 5, requested_rows: 10
    });
    expect(decidePlannedParticipation(ranking)).toEqual({ type: 'not_required' });

    expect(estimatePlannedF1QLCost(raceMetadataPlan())).toMatchObject({ units: 2, sources: 2, joins: 1, requested_rows: 30 });
    expect(decidePlannedParticipation(standingsRankPlan())).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['alpha-driver', 'beta-driver'] }]
    });
    expect(decidePlannedParticipation(classificationSelectionPlan('event_classification', ['alpha-driver', 'beta-driver']))).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['alpha-driver', 'beta-driver'] }]
    });
    const composition = parsePlannedF1QLProgram(scalarCompositionPlan());
    expect(estimatePlannedF1QLCost(composition)).toEqual({
      version: 'planned-cost-v1', units: 60, sources: 2, joins: 0, depth: 6, requested_rows: 1
    });
    expect(decidePlannedParticipation(composition)).toEqual({
      type: 'required', requirements: [{ season: 2025, driver_ids: ['alpha-driver', 'beta-driver'] }]
    });
    const core = lowerPlannedF1QL(composition);
    expect(core).toMatchObject({ version: 2, dialect: 'planned_f1ql_v2' });
    expect(core.root.input.input.output_grain).toEqual([]);
    expect(core.root.input.input.integrity).toContain('scalar_input_cardinality');
  });

  it.each([
    ['catalog substitution', (plan: any) => { plan.catalog_hash = '0'.repeat(64); }],
    ['v1 surface downgrade', (plan: any) => { plan.version = 1; }],
    ['extra field', (plan: any) => { plan.sql = 'SELECT 1'; }],
    ['source substitution', (plan: any) => { plan.root.input.input.input.input.input.source_id = 'event_metadata'; }],
    ['predicate source substitution', (plan: any) => { plan.root.input.input.input.input.predicates[0].concept.source_id = 'event_metadata'; }],
    ['unapproved aggregation', (plan: any) => { const aggregate = plan.root.input.input.input; aggregate.measures[0] = { concept: ref('driver_standings', 'points'), function: 'sum', as: 'sum_points' }; }],
    ['noncanonical measure ID', (plan: any) => { plan.root.input.input.input.measures[0].as = 'position'; }],
    ['missing grain output', (plan: any) => { plan.root.input.input.outputs = plan.root.input.input.outputs.filter((item: any) => item.as !== 'driver_id'); }],
    ['missing grain tie key', (plan: any) => { plan.root.input.keys = plan.root.input.keys.filter((item: any) => item.output_id !== 'driver_id'); }],
    ['duplicate sort key', (plan: any) => { plan.root.input.keys.push(structuredClone(plan.root.input.keys[0])); }],
    ['uncanonical IN values', (plan: any) => { plan.root.input.input.input.input.predicates[0].values = ['beta-driver', 'alpha-driver']; }],
    ['uncanonical predicate order', (plan: any) => { plan.root.input.input.input.input.predicates.reverse(); }]
  ])('rejects %s', (_name, mutate) => {
    const plan: any = structuredClone(standingsRankPlan());
    mutate(plan);
    expect(() => parsePlannedF1QLProgram(plan)).toThrow();
  });

  it('rejects forged join grains while permitting the derived singleton empty grain', () => {
    const multi: any = structuredClone(lowerPlannedF1QL(selectedRaceMetadataPlan(['alpha-driver', 'beta-driver'])));
    expect(multi.root.input.input.input.output_grain).toEqual([
      expect.objectContaining({ source_id: 'event_classification', concept_id: 'driver_id' })
    ]);
    multi.root.input.input.input.output_grain = [];
    expect(() => validatePlannedCoreProgram(multi)).toThrow();

    const singleton: any = structuredClone(lowerPlannedF1QL(selectedRaceMetadataPlan('alpha-driver')));
    expect(singleton.root.input.input.input.output_grain).toEqual([]);
    singleton.root.input.input.input.output_grain = [
      singleton.root.input.input.input.left.input.grain.find((concept: any) => concept.concept_id === 'driver_id')
    ];
    expect(() => validatePlannedCoreProgram(singleton)).toThrow();
  });

  it('orients the promoted qualifying metadata edge from the classification source', () => {
    const multi: any = lowerPlannedF1QL(selectedQualifyingMetadataPlan(['alpha-driver', 'beta-driver']));
    expect(multi.root.input.input.input).toMatchObject({
      relationship_id: 'qualifying_event_metadata',
      left: { input: { source_id: 'qualifying_classification' } },
      right: { input: { source_id: 'event_metadata' } },
      output_grain: [expect.objectContaining({ source_id: 'qualifying_classification', concept_id: 'driver_id' })]
    });
    const forged: any = structuredClone(multi);
    forged.root.input.input.input.left = structuredClone(multi.root.input.input.input.right);
    forged.root.input.input.input.right = structuredClone(multi.root.input.input.input.left);
    expect(() => validatePlannedCoreProgram(forged)).toThrow();
  });

  it.each([
    ['one input', (plan: any) => { plan.root.input.input.input.inputs.pop(); }],
    ['duplicate source', (plan: any) => { plan.root.input.input.input.inputs[1] = structuredClone(plan.root.input.input.input.inputs[0]); }],
    ['noncanonical source order', (plan: any) => { plan.root.input.input.input.inputs.reverse(); }],
    ['grouped child', (plan: any) => { plan.root.input.input.input.inputs[0].group_by = [ref('event_classification', 'driver_id')]; }],
    ['non-equality season', (plan: any) => { const season = plan.root.input.input.input.inputs[0].input.predicates[1]; season.operator = 'in'; season.values = [season.value]; delete season.value; }],
    ['different season', (plan: any) => { plan.root.input.input.input.inputs[1].input.predicates[1].value = 2024; }],
    ['mixed round scope', (plan: any) => { plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1)); }],
    ['different round scope', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1));
      plan.root.input.input.input.inputs[1].input.predicates.splice(1, 0, predicate('qualifying_classification', 'round', 2));
    }],
    ['singleton IN round', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, {
        concept: ref('event_classification', 'round'), operator: 'in', values: [1]
      });
    }],
    ['singleton range round', (plan: any) => {
      plan.root.input.input.input.inputs[0].input.predicates.splice(1, 0, {
        concept: ref('event_classification', 'round'), operator: 'range', min: 1, max: 1
      });
    }],
    ['limit above one', (plan: any) => { plan.root.count = 2; }],
    ['unqualified output alias', (plan: any) => { plan.root.input.input.outputs[0].as = 'count_finishing_position'; }],
    ['missing child measure projection', (plan: any) => { plan.root.input.input.outputs.pop(); }],
    ['extra concept projection', (plan: any) => { plan.root.input.input.outputs.push({ kind: 'concept', concept: ref('event_classification', 'season'), as: 'season' }); }],
    ['substituted output source', (plan: any) => { plan.root.input.input.outputs[0].source_id = 'qualifying_classification'; }]
  ])('rejects scalar composition surface mutation: %s', (_name, mutate) => {
    const plan: any = structuredClone(scalarCompositionPlan());
    mutate(plan);
    expect(() => parsePlannedF1QLProgram(plan)).toThrow();
  });

  it('sums scalar child work and rejects compositions above the 60-unit bound', () => {
    const roundScoped: any = structuredClone(scalarCompositionPlan());
    roundScoped.root.input.input.input.inputs[0].input.predicates.splice(1, 0, predicate('event_classification', 'round', 1));
    roundScoped.root.input.input.input.inputs[1].input.predicates.splice(1, 0, predicate('qualifying_classification', 'round', 1));
    expect(estimatePlannedF1QLCost(roundScoped)).toMatchObject({ units: 2, sources: 2, joins: 0, depth: 6 });

    const overBudget: any = structuredClone(scalarCompositionPlan());
    overBudget.root.input.input.input.inputs.unshift({
      op: 'aggregate',
      input: {
        op: 'filter', input: { op: 'source', source_id: 'driver_standings' },
        predicates: [predicate('driver_standings', 'driver_id', 'alpha-driver'), predicate('driver_standings', 'season', 2025)]
      },
      group_by: [],
      measures: [{ concept: ref('driver_standings', 'championship_position'), function: 'min', as: 'min_championship_position' }]
    });
    overBudget.root.input.input.outputs.unshift({
      kind: 'composed_aggregate', source_id: 'driver_standings',
      measure_as: 'min_championship_position', as: 'driver_standings__min_championship_position'
    });
    expect(parsePlannedF1QLProgram(overBudget)).toBeTruthy();
    expect(() => estimatePlannedF1QLCost(overBudget)).toThrow('exceeds 60 units');
  });

  it('rejects join scope, direction, source, and relationship mutations', () => {
    const wrongScope: any = structuredClone(raceMetadataPlan());
    wrongScope.root.input.input.input.right.predicates[0].value = 2;
    expect(() => parsePlannedF1QLProgram(wrongScope)).toThrow('same exact event scope');

    for (const conceptId of ['round', 'season']) {
      const singletonIn: any = structuredClone(raceMetadataPlan());
      for (const branch of [singletonIn.root.input.input.input.left, singletonIn.root.input.input.input.right]) {
        const scope = branch.predicates.find((item: any) => item.concept.concept_id === conceptId);
        scope.operator = 'in';
        scope.values = [scope.value];
        delete scope.value;
      }
      singletonIn.root.input.input.outputs.push({
        kind: 'concept', concept: ref('event_classification', conceptId), as: conceptId
      });
      singletonIn.root.input.keys.push({ output_id: conceptId, direction: 'asc', nulls: 'last' });
      expect(() => parsePlannedF1QLProgram(singletonIn)).toThrow('scalar equality');
    }

    const wrongRelationship: any = structuredClone(raceMetadataPlan());
    wrongRelationship.root.input.input.input.relationship_id = 'event_identity_race_resolution';
    expect(() => parsePlannedF1QLProgram(wrongRelationship)).toThrow('not a promoted row join');

    const core: any = structuredClone(lowerPlannedF1QL(raceMetadataPlan()));
    core.root.input.input.input.type = 'inner';
    expect(() => validatePlannedCoreProgram(core)).toThrow('catalog relationship');
    const wrongView: any = structuredClone(lowerPlannedF1QL(raceMetadataPlan()));
    wrongView.root.input.input.input.left.input.view = 'f1ql.qualifying_classification';
    expect(() => validatePlannedCoreProgram(wrongView)).toThrow('active catalog');
  });

  it('rejects out-of-domain literals before lowering', () => {
    const badPosition: any = structuredClone(qualifyingRankPlan());
    badPosition.root.input.input.input.input.predicates[0].max = 31;
    expect(() => parsePlannedF1QLProgram(badPosition)).toThrow('position literal is outside supported bounds');

    const badRound: any = structuredClone(raceMetadataPlan());
    badRound.root.input.input.input.left.predicates[0].value = 31;
    badRound.root.input.input.input.right.predicates[0].value = 31;
    expect(() => parsePlannedF1QLProgram(badRound)).toThrow('round literal is outside supported bounds');

    const badDate: any = structuredClone(eventMetadataRowsPlan());
    badDate.root.input.input.input.predicates.unshift({
      concept: ref('event_metadata', 'date'), operator: 'eq', value: '2025-02-30'
    });
    expect(() => parsePlannedF1QLProgram(badDate)).toThrow('date literal is invalid');
  });

  it('independently rejects forged Core before SQL compilation', () => {
    const injectedSort: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    injectedSort.root.input.keys[0].direction = 'desc; drop table race';
    expect(() => compilePlannedF1QL(injectedSort)).toThrow();

    const omittedIntegrity: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    omittedIntegrity.root.input.input.input.input.integrity = [];
    expect(() => compilePlannedF1QL(omittedIntegrity)).toThrow();

    const substitutedField: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    substitutedField.root.input.input.input.input.predicates[0].concept.physical_field = 'points';
    expect(() => compilePlannedF1QL(substitutedField)).toThrow();

    const substitutedSchema: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    substitutedSchema.result_schema[0].semantic_type = 'team_id';
    expect(() => compilePlannedF1QL(substitutedSchema)).toThrow();

    const omittedResidualGrain: any = structuredClone(lowerPlannedF1QL(eventMetadataRowsPlan()));
    omittedResidualGrain.root.input.input.outputs = omittedResidualGrain.root.input.input.outputs
      .filter((output: any) => output.as !== 'round');
    omittedResidualGrain.root.input.keys = omittedResidualGrain.root.input.keys
      .filter((key: any) => key.output_id !== 'round');
    omittedResidualGrain.root.input.input.output_grain = [];
    omittedResidualGrain.result_schema = omittedResidualGrain.result_schema
      .filter((field: any) => field.id !== 'round');
    expect(() => validatePlannedCoreProgram(omittedResidualGrain)).toThrow('must include grain key round');
    expect(() => compilePlannedF1QL(omittedResidualGrain)).toThrow('must include grain key round');

    const accessorCore: any = structuredClone(lowerPlannedF1QL(qualifyingRankPlan()));
    let directionReads = 0;
    accessorCore.root.input.keys[0] = new Proxy(accessorCore.root.input.keys[0], {
      get(target, property, receiver) {
        if (property === 'direction') return directionReads++ === 0 ? 'desc' : 'desc; drop table race';
        return Reflect.get(target, property, receiver);
      }
    });
    expect(compilePlannedF1QL(accessorCore).sql).not.toContain('drop table');
  });

  it.each([
    ['v1 version', (core: any) => { core.version = 1; }],
    ['v1 dialect', (core: any) => { core.dialect = 'planned_f1ql_v1'; }],
    ['source order', (core: any) => { core.root.input.input.input.inputs.reverse(); }],
    ['duplicate source', (core: any) => { core.root.input.input.input.inputs[1] = structuredClone(core.root.input.input.input.inputs[0]); }],
    ['grouped child', (core: any) => {
      const child = core.root.input.input.input.inputs[0];
      child.group_by = [structuredClone(child.input.input.grain[0])];
      child.output_grain = structuredClone(child.group_by);
    }],
    ['season scope', (core: any) => { core.root.input.input.input.inputs[1].input.predicates[1].value = 2024; }],
    ['singleton IN round', (core: any) => {
      const child = core.root.input.input.input.inputs[0].input;
      child.predicates.splice(1, 0, {
        concept: structuredClone(child.input.grain.find((item: any) => item.concept_id === 'round')),
        operator: 'in', values: [1]
      });
    }],
    ['singleton range round', (core: any) => {
      const child = core.root.input.input.input.inputs[0].input;
      child.predicates.splice(1, 0, {
        concept: structuredClone(child.input.grain.find((item: any) => item.concept_id === 'round')),
        operator: 'range', min: 1, max: 1
      });
    }],
    ['scalar marker', (core: any) => {
      core.root.input.input.input.integrity = core.root.input.input.input.integrity.filter((item: string) => item !== 'scalar_input_cardinality');
    }],
    ['output grain', (core: any) => { core.root.input.input.input.output_grain = [structuredClone(core.root.input.input.input.inputs[0].input.input.grain[0])]; }],
    ['child integrity', (core: any) => { core.root.input.input.input.inputs[0].integrity = []; }],
    ['output alias', (core: any) => { core.root.input.input.outputs[0].as = 'count_finishing_position'; }],
    ['output source', (core: any) => { core.root.input.input.outputs[0].source_id = 'qualifying_classification'; }],
    ['extra concept output', (core: any) => {
      core.root.input.input.outputs.push({
        kind: 'concept', as: 'season', concept: structuredClone(core.root.input.input.input.inputs[0].input.input.grain[2])
      });
      core.result_schema.push({ id: 'season', physical_type: 'integer', semantic_type: 'season', nullable: false });
    }],
    ['result schema', (core: any) => { core.result_schema[0].semantic_type = 'position'; }],
    ['limit', (core: any) => { core.root.count = 2; }]
  ])('independently rejects scalar composition Core mutation: %s', (_name, mutate) => {
    const core: any = structuredClone(lowerPlannedF1QL(scalarCompositionPlan()));
    mutate(core);
    expect(() => validatePlannedCoreProgram(core)).toThrow();
    expect(() => compilePlannedF1QL(core)).toThrow();
  });

  it('prepares only runtime-provenance parents and never exposes the planned dialect through public F1QL', () => {
    const parent = preparePlannedF1QLParent(qualifyingRankPlan());
    expect(verifyPlannedF1QLParent(parent)).toBe(parent);
    expect(parent.program_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parent.core_hash).toBe(getPlannedCoreProgramHash(parent.core_program));
    expect(Object.isFrozen(parent)).toBe(true);
    expect(() => verifyPlannedF1QLParent({ ...parent })).toThrow('provenance');
    expect(() => parseF1QLProgram(parent.program)).toThrow();

    const executorSource = readFileSync('src/f1ql/executor.ts', 'utf8');
    const routeSource = readFileSync('src/api/routes/program.ts', 'utf8');
    expect(executorSource).not.toMatch(/planned-(f1ql|compiler|pipeline)/);
    expect(routeSource).not.toMatch(/planned-(f1ql|compiler|pipeline)/);
    expect(readFileSync('src/f1ql/planned-pipeline.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);

    const compositionParent = preparePlannedF1QLParent(scalarCompositionPlan());
    expect(verifyPlannedF1QLParent(compositionParent)).toBe(compositionParent);
    expect(compositionParent.core_program).toMatchObject({ version: 2, dialect: 'planned_f1ql_v2' });
    expect(() => parseF1QLProgram(compositionParent.program)).toThrow();
    expect(readFileSync('src/f1ql/planned-compiler.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);
    expect(readFileSync('src/f1ql/planned-interpreter.ts', 'utf8')).not.toMatch(/executeF1QL|executeF1QLReadOnly/);
  });

  it('compiles only catalog identifiers and parameterizes every literal and limit', () => {
    const compiled = compilePlannedF1QL(lowerPlannedF1QL(raceMetadataPlan()));
    expect(compiled.sql).toContain('f1ql.event_classification');
    expect(compiled.sql).toContain('f1ql.event_metadata');
    expect(compiled.sql).toContain('LEFT JOIN');
    expect(compiled.sql).toContain('COLLATE "C"');
    expect(compiled.sql).not.toContain('2025');
    expect(compiled.params).toEqual([1, 2025, 1, 2025, 30]);
    expect(compiled.sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3', '$4', '$5']);
  });

  it('derives only the exact zero-or-one-row collection probe from canonical compilation', () => {
    const core = lowerPlannedF1QL(raceMetadataPlan());
    const base = compilePlannedF1QL(core);
    const exact = compilePlannedF1QLResultCollection(core, 0);
    const probed = compilePlannedF1QLResultCollection(core, 1);
    expect(exact).toEqual(base);
    expect(probed.sql).toBe(base.sql);
    expect(probed.params.slice(0, -1)).toEqual(base.params.slice(0, -1));
    expect(base.params.at(-1)).toBe(30);
    expect(probed.params.at(-1)).toBe(31);
    expect(() => compilePlannedF1QLResultCollection(core, 2 as never))
      .toThrow('planned result collection binding');
  });

  it('independently aggregates and CROSS JOINs scalar sources with differential integrity', async () => {
    const core = lowerPlannedF1QL(scalarCompositionPlan());
    const compiled = compilePlannedF1QL(core);
    expect(compiled.sql).toContain('CROSS JOIN');
    expect(compiled.sql).toContain('"planned_scalar_event_classification"');
    expect(compiled.sql).toContain('"planned_scalar_qualifying_classification"');
    expect(compiled.sql).toContain('AND');
    expect(compiled.params).toEqual([2025, 'alpha-driver', 2025, 'beta-driver', 1]);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' },
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' }
      ],
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 1,
      [PLANNED_INTEGRITY_FIELD]: true
    }]);

    const missingPlan: any = structuredClone(scalarCompositionPlan());
    missingPlan.root.input.input.input.inputs[1].input.predicates[0].value = 'missing-driver';
    const missingCore = lowerPlannedF1QL(missingPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      event_classification__count_finishing_position: 1,
      qualifying_classification__count_qualifying_position: 0,
      [PLANNED_INTEGRITY_FIELD]: false
    }]);
  });

  it('matches PostgreSQL for a catalog-bound single-source aggregate rank', async () => {
    const core = lowerPlannedF1QL(qualifyingRankPlan());
    const compiled = compilePlannedF1QL(core);
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', team_id: 'planned-team', qualifying_position: 2, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', team_id: 'planned-team', qualifying_position: 1, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' },
        { season: 2025, round: 2, driver_id: 'outside-driver', team_id: 'planned-team', qualifying_position: 11, best_time_ms: null, best_session: null, eliminated_in_round: null, classification_status: 'classified' }
      ]
    };
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL for standings ranking with participation-bound drivers', async () => {
    const core = lowerPlannedF1QL(standingsRankPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: 100 },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: 90 }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', min_championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', min_championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL for selected-driver official standings ranking and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(selectedStandingsPositionRankPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: 100 },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: 100 },
        { season: 2025, driver_id: 'outside-driver', championship_position: 3, championship_won: false, points: 80 }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const missingCore = lowerPlannedF1QL(selectedStandingsPositionRankPlan(['alpha-driver', 'missing-driver']));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: false
    }]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE season_driver_standing SET position_number = NULL WHERE year = 2025 AND driver_id = $1', ['outside_driver']);
        const nullReference: PlannedReferenceDatabase = {
          driver_standings: [
            reference.driver_standings![0],
            reference.driver_standings![1],
            { ...reference.driver_standings![2], championship_position: null }
          ]
        };
        const nullRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(nullRows).toEqual(interpretPlannedF1QL(core, nullReference));
        expect(nullRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query('UPDATE season_driver_standing SET position_number = 1 WHERE year = 2025 AND driver_id = $1', ['outside_driver']);
        const tiedReference: PlannedReferenceDatabase = {
          driver_standings: [
            reference.driver_standings![0],
            reference.driver_standings![1],
            { ...reference.driver_standings![2], championship_position: 1 }
          ]
        };
        const tiedRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(tiedRows).toEqual(interpretPlannedF1QL(core, tiedReference));
        expect(tiedRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query('UPDATE season_driver_standing SET position_number = 0 WHERE year = 2025 AND driver_id = $1', ['outside_driver']);
        const outOfBoundsReference: PlannedReferenceDatabase = {
          driver_standings: [
            reference.driver_standings![0],
            reference.driver_standings![1],
            { ...reference.driver_standings![2], championship_position: 0 }
          ]
        };
        const outOfBoundsRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(outOfBoundsRows).toEqual(interpretPlannedF1QL(core, outOfBoundsReference));
        expect(outOfBoundsRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO season_driver_standing
          (year, position_display_order, position_number, driver_id, points, championship_won)
          VALUES (2025, 4, 4, 'outside_driver', 70, false)`);
        const duplicateReference: PlannedReferenceDatabase = {
          driver_standings: [
            ...reference.driver_standings!,
            { season: 2025, driver_id: 'outside-driver', championship_position: 4, championship_won: false, points: 70 }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for one-driver final standings-position selection and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(selectedStandingsPositionPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: 100 },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: 90 },
        { season: 2025, driver_id: 'outside-driver', championship_position: 3, championship_won: false, points: 80 }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{
      driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true
    }]);

    const missingCore = lowerPlannedF1QL(selectedStandingsPositionPlan('missing-driver'));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { driver: 'alpha_driver', position: null, expectedPosition: null, integrity: true },
        { driver: 'alpha_driver', position: 31, expectedPosition: 31, integrity: true },
        { driver: 'alpha_driver', position: 0, expectedPosition: 0, integrity: false },
        { driver: 'beta_driver', position: null, expectedPosition: 1, integrity: true },
        { driver: 'beta_driver', position: 1, expectedPosition: 1, integrity: true },
        { driver: 'beta_driver', position: 31, expectedPosition: 1, integrity: true },
        { driver: 'beta_driver', position: 0, expectedPosition: 1, integrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE season_driver_standing SET position_number = $1 WHERE year = 2025 AND driver_id = $2',
            [mutation.position, mutation.driver]
          );
          const mutatedReference: PlannedReferenceDatabase = {
            driver_standings: reference.driver_standings!.map(row =>
              row.driver_id === mutation.driver.replace('_', '-')
                ? { ...row, championship_position: mutation.position }
                : row)
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([{
            driver_id: 'alpha-driver', championship_position: mutation.expectedPosition,
            [PLANNED_INTEGRITY_FIELD]: mutation.integrity
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      for (const driver of ['outside_driver', 'alpha_driver']) {
        await client.query('BEGIN');
        try {
          await client.query(`INSERT INTO season_driver_standing
            (year, position_display_order, position_number, driver_id, points, championship_won)
            VALUES (2025, 4, 4, $1, 70, false)`, [driver]);
          const duplicateReference: PlannedReferenceDatabase = {
            driver_standings: [
              ...reference.driver_standings!,
              {
                season: 2025, driver_id: driver.replace('_', '-'), championship_position: 4,
                championship_won: false, points: 70
              }
            ]
          };
          const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
          expect(duplicateRows).toEqual([{
            driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: false
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for one-driver final standings position and points', async () => {
    const core = lowerPlannedF1QL(selectedStandingsSummaryPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: '100' },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: '90' },
        { season: 2025, driver_id: 'outside-driver', championship_position: 3, championship_won: false, points: '80' }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{
      driver_id: 'alpha-driver', championship_position: 1, points: '100', [PLANNED_INTEGRITY_FIELD]: true
    }]);

    const missingCore = lowerPlannedF1QL(selectedStandingsSummaryPlan('missing-driver'));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('ALTER TABLE season_driver_standing ALTER COLUMN points DROP NOT NULL');
        await client.query(
          'UPDATE season_driver_standing SET position_number = NULL, points = NULL WHERE year = 2025 AND driver_id = $1',
          ['alpha_driver']
        );
        const nullReference: PlannedReferenceDatabase = {
          driver_standings: reference.driver_standings!.map(row => row.driver_id === 'alpha-driver'
            ? { ...row, championship_position: null, points: null }
            : row)
        };
        const nullRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(nullRows).toEqual(interpretPlannedF1QL(core, nullReference));
        expect(nullRows).toEqual([{
          driver_id: 'alpha-driver', championship_position: null, points: null,
          [PLANNED_INTEGRITY_FIELD]: true
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO season_driver_standing
          (year, position_display_order, position_number, driver_id, points, championship_won)
          VALUES (2025, 4, 4, 'outside_driver', 70, false)`);
        const duplicateReference: PlannedReferenceDatabase = {
          driver_standings: [
            ...reference.driver_standings!,
            { season: 2025, driver_id: 'outside-driver', championship_position: 4, championship_won: false, points: '70' }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows).toEqual([{
          driver_id: 'alpha-driver', championship_position: 1, points: '100',
          [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for multiple selected drivers final standings position and points', async () => {
    const core = lowerPlannedF1QL(selectedStandingsSummaryPlan(['alpha-driver', 'beta-driver']));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: '100' },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: '90' },
        { season: 2025, driver_id: 'outside-driver', championship_position: 3, championship_won: false, points: '80' }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([
      { driver_id: 'alpha-driver', championship_position: 1, points: '100', [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', championship_position: 2, points: '90', [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const missingCore = lowerPlannedF1QL(selectedStandingsSummaryPlan(['alpha-driver', 'missing-driver']));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      driver_id: 'alpha-driver', championship_position: 1, points: '100', [PLANNED_INTEGRITY_FIELD]: false
    }]);
  });

  it('matches PostgreSQL for selected final standings positions with nullable and equal source facts', async () => {
    const core = lowerPlannedF1QL(selectedStandingsPositionsPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      driver_standings: [
        { season: 2025, driver_id: 'alpha-driver', championship_position: 1, championship_won: true, points: 100 },
        { season: 2025, driver_id: 'beta-driver', championship_position: 2, championship_won: false, points: 90 },
        { season: 2025, driver_id: 'outside-driver', championship_position: 3, championship_won: false, points: 80 }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([
      { driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const missingCore = lowerPlannedF1QL(selectedStandingsPositionsPlan(['alpha-driver', 'missing-driver']));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: false
    }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { driver: 'alpha_driver', position: null, selected: [null, 2], integrity: true },
        { driver: 'beta_driver', position: null, selected: [1, null], integrity: true },
        { driver: 'beta_driver', position: 1, selected: [1, 1], integrity: true },
        { driver: 'beta_driver', position: 31, selected: [1, 31], integrity: true },
        { driver: 'beta_driver', position: 0, selected: [1, 0], integrity: false },
        { driver: 'outside_driver', position: null, selected: [1, 2], integrity: true },
        { driver: 'outside_driver', position: 1, selected: [1, 2], integrity: true },
        { driver: 'outside_driver', position: 31, selected: [1, 2], integrity: true },
        { driver: 'outside_driver', position: 0, selected: [1, 2], integrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE season_driver_standing SET position_number = $1 WHERE year = 2025 AND driver_id = $2',
            [mutation.position, mutation.driver]
          );
          const mutatedReference: PlannedReferenceDatabase = {
            driver_standings: reference.driver_standings!.map(row =>
              row.driver_id === mutation.driver.replace('_', '-')
                ? { ...row, championship_position: mutation.position }
                : row)
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([
            {
              driver_id: 'alpha-driver', championship_position: mutation.selected[0],
              [PLANNED_INTEGRITY_FIELD]: mutation.integrity
            },
            {
              driver_id: 'beta-driver', championship_position: mutation.selected[1],
              [PLANNED_INTEGRITY_FIELD]: mutation.integrity
            }
          ]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      for (const driver of ['outside_driver', 'alpha_driver']) {
        await client.query('BEGIN');
        try {
          await client.query(`INSERT INTO season_driver_standing
            (year, position_display_order, position_number, driver_id, points, championship_won)
            VALUES (2025, 4, 4, $1, 70, false)`, [driver]);
          const duplicateReference: PlannedReferenceDatabase = {
            driver_standings: [
              ...reference.driver_standings!,
              {
                season: 2025, driver_id: driver.replace('_', '-'), championship_position: 4,
                championship_won: false, points: 70
              }
            ]
          };
          const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
          expect(duplicateRows).toEqual(driver === 'alpha_driver'
            ? [
                { driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: false },
                { driver_id: 'alpha-driver', championship_position: 4, [PLANNED_INTEGRITY_FIELD]: false },
                { driver_id: 'beta-driver', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: false }
              ]
            : [
                { driver_id: 'alpha-driver', championship_position: 1, [PLANNED_INTEGRITY_FIELD]: false },
                { driver_id: 'beta-driver', championship_position: 2, [PLANNED_INTEGRITY_FIELD]: false }
              ]);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL row projection under descending nulls-last and UTF-8 byte ordering', async () => {
    const core = lowerPlannedF1QL(eventMetadataRowsPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [
        { season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix', circuit_id: 'planned-circuit', date: '2025-01-01' },
        { season: 2025, round: 2, event_id: 'empty-circuit', event_name: null, circuit_id: 'empty-circuit', date: '2025-02-01' },
        { season: 2025, round: 3, event_id: 'unicode-gp', event_name: '\u00c9clair Grand Prix', circuit_id: 'unicode-circuit', date: '2025-03-01' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { event_name: '\u00c9clair Grand Prix', round: 3, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: 'Formula 1 Planned Grand Prix', round: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { event_name: null, round: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL for one-event race date and checks the complete event key', async () => {
    const core = lowerPlannedF1QL(eventDatePlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
        circuit_id: 'planned-circuit', date: '2025-01-01'
      }]
    };
    const client = await pool.connect();
    let sqlRows: Record<string, unknown>[];
    try {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL datestyle = 'SQL, DMY'");
        sqlRows = (await client.query(compiled.sql, compiled.params)).rows;
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{ date: '2025-01-01', [PLANNED_INTEGRITY_FIELD]: true }]);

    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9804, 2025, 1, 'planned_gp', 'other-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
      const corruptReference: PlannedReferenceDatabase = {
        event_metadata: [
          ...reference.event_metadata!,
          { season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix', circuit_id: 'other-circuit', date: '2025-01-02' }
        ]
      };
      const corruptRows = (await pool.query(compiled.sql, compiled.params)).rows;
      expect(corruptRows).toEqual(interpretPlannedF1QL(core, corruptReference));
      expect(corruptRows).toEqual([{ date: '2025-01-01', [PLANNED_INTEGRITY_FIELD]: false }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for a one-event circuit identifier', async () => {
    const core = lowerPlannedF1QL(eventCircuitPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
        circuit_id: 'planned-circuit', date: '2025-01-01'
      }]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{ circuit_id: 'planned-circuit', [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingCore = lowerPlannedF1QL(eventCircuitPlan(4));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
          VALUES (9804, 2025, 1, 'planned_gp', 'Other_Circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
        const corruptReference: PlannedReferenceDatabase = {
          event_metadata: [
            ...reference.event_metadata!,
            {
              season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
              circuit_id: 'Other_Circuit', date: '2025-01-02'
            }
          ]
        };
        const corruptRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(corruptRows).toEqual(interpretPlannedF1QL(core, corruptReference));
        expect(corruptRows).toEqual([{ circuit_id: 'Other_Circuit', [PLANNED_INTEGRITY_FIELD]: false }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for one nullable event name and checks the complete event key', async () => {
    const core = lowerPlannedF1QL(eventNamePlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
        circuit_id: 'planned-circuit', date: '2025-01-01'
      }]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{
      event_name: 'Formula 1 Planned Grand Prix', [PLANNED_INTEGRITY_FIELD]: true
    }]);

    const nullCore = lowerPlannedF1QL(eventNamePlan(2));
    const nullCompiled = compilePlannedF1QL(nullCore);
    const nullReference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025, round: 2, event_id: 'empty-circuit', event_name: null,
        circuit_id: 'empty-circuit', date: '2025-02-01'
      }]
    };
    const nullRows = (await pool.query(nullCompiled.sql, nullCompiled.params)).rows;
    expect(nullRows).toEqual(interpretPlannedF1QL(nullCore, nullReference));
    expect(nullRows).toEqual([{ event_name: null, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingCore = lowerPlannedF1QL(eventNamePlan(4));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([]);

    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9804, 2025, 1, 'planned_gp', 'other-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
      const corruptReference: PlannedReferenceDatabase = {
        event_metadata: [
          ...reference.event_metadata!,
          {
            season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
            circuit_id: 'other-circuit', date: '2025-01-02'
          }
        ]
      };
      const corruptRows = (await pool.query(compiled.sql, compiled.params)).rows;
      expect(corruptRows).toEqual(interpretPlannedF1QL(core, corruptReference));
      expect(corruptRows).toEqual([{
        event_name: 'Formula 1 Planned Grand Prix', [PLANNED_INTEGRITY_FIELD]: false
      }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for one event date-and-name pair with nullable source facts', async () => {
    const core = lowerPlannedF1QL(eventDateNamePlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
        circuit_id: 'planned-circuit', date: '2025-01-01'
      }]
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL datestyle = 'SQL, DMY'");
        const rows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(rows).toEqual(interpretPlannedF1QL(core, reference));
        expect(rows).toEqual([{
          date: '2025-01-01', event_name: 'Formula 1 Planned Grand Prix',
          [PLANNED_INTEGRITY_FIELD]: true
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      const nullNameCore = lowerPlannedF1QL(eventDateNamePlan(2));
      const nullNameCompiled = compilePlannedF1QL(nullNameCore);
      const nullNameReference: PlannedReferenceDatabase = {
        event_metadata: [{
          season: 2025, round: 2, event_id: null, event_name: null,
          circuit_id: 'empty-circuit', date: '2025-02-01'
        }]
      };
      const nullNameRows = (await client.query(nullNameCompiled.sql, nullNameCompiled.params)).rows;
      expect(nullNameRows).toEqual(interpretPlannedF1QL(nullNameCore, nullNameReference));
      expect(nullNameRows).toEqual([{
        date: '2025-02-01', event_name: null, [PLANNED_INTEGRITY_FIELD]: true
      }]);

      const missingCore = lowerPlannedF1QL(eventDateNamePlan(4));
      const missingCompiled = compilePlannedF1QL(missingCore);
      expect((await client.query(missingCompiled.sql, missingCompiled.params)).rows)
        .toEqual(interpretPlannedF1QL(missingCore, reference));

      await client.query('BEGIN');
      try {
        await client.query('UPDATE race SET date = NULL WHERE year = 2025 AND round = 2');
        const bothNullReference: PlannedReferenceDatabase = {
          event_metadata: [{
            season: 2025, round: 2, event_id: null, event_name: null,
            circuit_id: 'empty-circuit', date: null
          }]
        };
        const bothNullRows = (await client.query(nullNameCompiled.sql, nullNameCompiled.params)).rows;
        expect(bothNullRows).toEqual(interpretPlannedF1QL(nullNameCore, bothNullReference));
        expect(bothNullRows).toEqual([{
          date: null, event_name: null, [PLANNED_INTEGRITY_FIELD]: true
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
          VALUES (9804, 2025, 1, 'planned_gp', 'other-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
        const corruptReference: PlannedReferenceDatabase = {
          event_metadata: [
            ...reference.event_metadata!,
            {
              season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix',
              circuit_id: 'other-circuit', date: '2025-01-02'
            }
          ]
        };
        const corruptRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(corruptRows).toEqual(interpretPlannedF1QL(core, corruptReference));
        expect(corruptRows).toEqual([{
          date: '2025-01-01', event_name: 'Formula 1 Planned Grand Prix',
          [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it.each([
    [['date', 'circuit_id']],
    [['event_name', 'circuit_id']],
    [['date', 'event_name', 'circuit_id']]
  ] as const)('matches PostgreSQL for a real historical Australian Grand Prix projection: %j', async (conceptIds) => {
    const core = lowerPlannedF1QL(eventMetadataProjectionPlan(conceptIds));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_metadata: [{
        season: 2025,
        round: 1,
        event_id: 'planned-gp',
        event_name: 'Formula 1 Australian Grand Prix',
        circuit_id: 'albert-park',
        date: '2025-03-16'
      }]
    };
    const expected = Object.fromEntries([
      ...conceptIds.map(conceptId => [conceptId, reference.event_metadata![0][conceptId]]),
      [PLANNED_INTEGRITY_FIELD, true]
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`UPDATE grand_prix
          SET full_name = 'Formula 1 Australian Grand Prix'
          WHERE id = 'planned_gp'`);
        await client.query(`UPDATE race
          SET circuit_id = 'albert-park', date = '2025-03-16'
          WHERE year = 2025 AND round = 1`);
        await client.query("SET LOCAL datestyle = 'SQL, DMY'");
        const rows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(rows).toEqual(interpretPlannedF1QL(core, reference));
        expect(rows).toEqual([expected]);

        await client.query(`INSERT INTO race
          (id, year, round, grand_prix_id, circuit_id, official_name, date)
          VALUES (9804, 2025, 1, 'planned_gp', 'melbourne', 'DUPLICATE AUSTRALIAN EVENT', '2025-03-17')`);
        const duplicateReference: PlannedReferenceDatabase = {
          event_metadata: [
            ...reference.event_metadata!,
            {
              season: 2025, round: 1, event_id: 'planned-gp',
              event_name: 'Formula 1 Australian Grand Prix', circuit_id: 'melbourne', date: '2025-03-17'
            }
          ]
        };
        const corruptRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(corruptRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(corruptRows[0]).toMatchObject({ [PLANNED_INTEGRITY_FIELD]: false });
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL exact numeric projection and ordering beyond safe integers', async () => {
    const core = lowerPlannedF1QL(eventPointsPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { points: '9007199254740993', driver_id: 'alpha-driver', [PLANNED_INTEGRITY_FIELD]: true },
      { points: '9007199254740992', driver_id: 'beta-driver', [PLANNED_INTEGRITY_FIELD]: true }
    ]);
  });

  it('matches PostgreSQL for selected event classification rows and checks the full event grain', async () => {
    const plan = classificationSelectionPlan('event_classification', ['alpha-driver', 'beta-driver']);
    const core = lowerPlannedF1QL(plan);
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' }
      ]
    };
    expect(compiled.sql).toContain('COLLATE "C"');
    expect(compiled.sql).toContain('planned_scope');
    expect(compiled.sql).not.toContain('alpha-driver');
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const singletonCore = lowerPlannedF1QL(classificationSelectionPlan('event_classification', ['alpha-driver']));
    const singletonCompiled = compilePlannedF1QL(singletonCore);
    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9804, 2025, 1, 'planned_gp', 'planned-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
      await pool.query(`INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
        VALUES (9804, 'race', 'beta_driver', 'planned-team', 20, 20, 0)`);
      const corruptReference: PlannedReferenceDatabase = {
        event_classification: [
          ...reference.event_classification!,
          { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 20, points: 0 }
        ]
      };
      const corruptRows = (await pool.query(singletonCompiled.sql, singletonCompiled.params)).rows;
      expect(corruptRows).toEqual(interpretPlannedF1QL(singletonCore, corruptReference));
      expect(corruptRows).toEqual([{
        driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: false
      }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for nullable and tied selected-driver race ranking with source-wide integrity', async () => {
    const core = lowerPlannedF1QL(selectedClassificationPositionRankPlan('event_classification'));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2, points: '9007199254740992' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1, points: '9007199254740993' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const missingCore = lowerPlannedF1QL(selectedClassificationPositionRankPlan(
      'event_classification', ['alpha-driver', 'missing-driver']
    ));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: false
    }]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE race_data SET position_number = NULL WHERE race_id = 9801 AND driver_id = $1', ['beta_driver']);
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9801, 'race', 'outside_driver', 'planned-team', 3, NULL, 0)`);
        const nullReference: PlannedReferenceDatabase = {
          event_classification: [
            reference.event_classification![1],
            { ...reference.event_classification![0], finishing_position: null },
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: null, points: 0 }
          ]
        };
        const nullRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(nullRows).toEqual(interpretPlannedF1QL(core, nullReference));
        expect(nullRows).toEqual([
          { driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
          { driver_id: 'beta-driver', finishing_position: null, [PLANNED_INTEGRITY_FIELD]: true }
        ]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query('UPDATE race_data SET position_number = 1 WHERE race_id = 9801 AND driver_id = $1', ['beta_driver']);
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9801, 'race', 'outside_driver', 'planned-team', 3, 1, 0)`);
        const tiedReference: PlannedReferenceDatabase = {
          event_classification: [
            reference.event_classification![1],
            { ...reference.event_classification![0], finishing_position: 1 },
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: 1, points: 0 }
          ]
        };
        const tiedRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(tiedRows).toEqual(interpretPlannedF1QL(core, tiedReference));
        expect(tiedRows).toEqual([
          { driver_id: 'alpha-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
          { driver_id: 'beta-driver', finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true }
        ]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9801, 'race', 'outside_driver', 'planned-team', 3, 0, 0)`);
        const invalidReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: 0, points: 0 }
          ]
        };
        const invalidRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(invalidRows).toEqual(interpretPlannedF1QL(core, invalidReference));
        expect(invalidRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9801, 'race', 'outside_driver', 'planned-team', 3, 31, 0)`);
        const aboveBoundReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: 31, points: 0 }
          ]
        };
        const aboveBoundRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(aboveBoundRows).toEqual(interpretPlannedF1QL(core, aboveBoundReference));
        expect(aboveBoundRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
          VALUES (9804, 2025, 1, 'planned_gp', 'planned-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
          VALUES (9804, 'race', 'outside_driver', 'planned-team', 3, 3, 0),
                 (9801, 'race', 'outside_driver', 'planned-team', 3, 3, 0)`);
        const duplicateReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: 3, points: 0 },
            { season: 2025, round: 1, driver_id: 'outside-driver', finishing_position: 3, points: 0 }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for selected-driver qualifying ranking and rejects event-wide nulls and ties', async () => {
    const core = lowerPlannedF1QL(selectedClassificationPositionRankPlan('qualifying_classification'));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const missingCore = lowerPlannedF1QL(selectedClassificationPositionRankPlan(
      'qualifying_classification', ['alpha-driver', 'missing-driver']
    ));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{
      driver_id: 'alpha-driver', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: false
    }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        {
          sql: 'UPDATE qualifying_results SET qualifying_position = NULL WHERE season = 2025 AND round = 1 AND driver_id = $1',
          params: ['beta_driver'],
          row: { ...reference.qualifying_classification![0], qualifying_position: null }
        },
        {
          sql: `INSERT INTO qualifying_results
            (season, round, driver_id, team_id, qualifying_position, session_type)
            VALUES (2025, 1, 'outside_driver', 'planned-team', NULL, 'RACE_QUALIFYING')`,
          params: [],
          row: { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: null, classification_status: 'classified' }
        },
        {
          sql: 'UPDATE qualifying_results SET qualifying_position = 1 WHERE season = 2025 AND round = 1 AND driver_id = $1',
          params: ['beta_driver'],
          row: { ...reference.qualifying_classification![0], qualifying_position: 1 }
        },
        {
          sql: `INSERT INTO qualifying_results
            (season, round, driver_id, team_id, qualifying_position, session_type)
            VALUES (2025, 1, 'outside_driver', 'planned-team', 1, 'RACE_QUALIFYING')`,
          params: [],
          row: { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: 1, classification_status: 'classified' }
        },
        {
          sql: `INSERT INTO qualifying_results
            (season, round, driver_id, team_id, qualifying_position, session_type)
            VALUES (2025, 1, 'outside_driver', 'planned-team', 0, 'RACE_QUALIFYING')`,
          params: [],
          row: { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: 0, classification_status: 'classified' }
        },
        {
          sql: `INSERT INTO qualifying_results
            (season, round, driver_id, team_id, qualifying_position, session_type)
            VALUES (2025, 1, 'outside_driver', 'planned-team', 31, 'RACE_QUALIFYING')`,
          params: [],
          row: { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: 31, classification_status: 'classified' }
        }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(mutation.sql, [...mutation.params]);
          const mutationReference: PlannedReferenceDatabase = {
            qualifying_classification: mutation.sql.startsWith('UPDATE')
              ? [reference.qualifying_classification![1], mutation.row]
              : [...reference.qualifying_classification!, mutation.row]
          };
          const mutationRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutationRows).toEqual(interpretPlannedF1QL(core, mutationReference));
          expect(mutationRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO qualifying_results
          (season, round, driver_id, team_id, qualifying_position, session_type)
          VALUES (2025, 1, 'outside_driver', 'planned-team', 3, 'RACE_QUALIFYING'),
                 (2025, 1, 'outside-driver', 'planned-team', 4, 'RACE_QUALIFYING')`);
        const duplicateReference: PlannedReferenceDatabase = {
          qualifying_classification: [
            ...reference.qualifying_classification!,
            { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: 3, classification_status: 'classified' },
            { season: 2025, round: 1, driver_id: 'outside-driver', qualifying_position: 4, classification_status: 'classified' }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for selected qualifying rows and checks the full event grain', async () => {
    const plan = classificationSelectionPlan('qualifying_classification', ['alpha-driver', 'beta-driver']);
    const core = lowerPlannedF1QL(plan);
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' }
      ]
    };
    expect(compiled.sql).toContain('COLLATE "C"');
    expect(compiled.sql).toContain('planned_scope');
    expect(compiled.sql).not.toContain('alpha-driver');
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([
      { driver_id: 'alpha-driver', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true },
      { driver_id: 'beta-driver', qualifying_position: 2, [PLANNED_INTEGRITY_FIELD]: true }
    ]);

    const singletonCore = lowerPlannedF1QL(
      classificationSelectionPlan('qualifying_classification', ['alpha-driver'])
    );
    const singletonCompiled = compilePlannedF1QL(singletonCore);
    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO driver (id, name, full_name, abbreviation)
        VALUES ('beta-driver', 'Canonical Beta', 'Canonical Beta Driver', 'CBT')`);
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2025, 1, 'beta-driver', 'planned-team', 20, 'RACE_QUALIFYING')`);
      const corruptReference: PlannedReferenceDatabase = {
        qualifying_classification: [
          ...reference.qualifying_classification!,
          { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 20, classification_status: 'classified' }
        ]
      };
      const corruptRows = (await pool.query(singletonCompiled.sql, singletonCompiled.params)).rows;
      expect(corruptRows).toEqual(interpretPlannedF1QL(singletonCore, corruptReference));
      expect(corruptRows).toEqual([{
        driver_id: 'alpha-driver', qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: false
      }]);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for scalar recorded qualifying-position counts and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(scalarQualifyingCountPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
        { season: 2025, round: 2, driver_id: 'outside-driver', qualifying_position: 11, classification_status: 'classified' }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{ count_qualifying_position: 3, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingPlan: any = structuredClone(scalarQualifyingCountPlan());
    missingPlan.root.input.input.input.input.predicates[0].value = 2024;
    const missingCore = lowerPlannedF1QL(missingPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, { qualifying_classification: [] }));
    expect(missingRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { position: null, expectedCount: 2, expectedIntegrity: true },
        { position: 1, expectedCount: 3, expectedIntegrity: true },
        { position: 0, expectedCount: 3, expectedIntegrity: false },
        { position: 31, expectedCount: 3, expectedIntegrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE qualifying_results SET qualifying_position = $1 WHERE season = 2025 AND round = 1 AND driver_id = $2',
            [mutation.position, 'beta_driver']
          );
          const mutatedReference: PlannedReferenceDatabase = {
            qualifying_classification: [
              reference.qualifying_classification![0],
              { ...reference.qualifying_classification![1], qualifying_position: mutation.position },
              reference.qualifying_classification![2]
            ]
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([{
            count_qualifying_position: mutation.expectedCount,
            [PLANNED_INTEGRITY_FIELD]: mutation.expectedIntegrity
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      await client.query('BEGIN');
      try {
        await client.query('UPDATE qualifying_results SET qualifying_position = NULL WHERE season = 2025');
        const allNullReference: PlannedReferenceDatabase = {
          qualifying_classification: reference.qualifying_classification!.map(row => ({
            ...row, qualifying_position: null
          }))
        };
        const allNullRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(allNullRows).toEqual(interpretPlannedF1QL(core, allNullReference));
        expect(allNullRows).toEqual([{
          count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: true
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO qualifying_results
          (season, round, driver_id, team_id, qualifying_position, session_type)
          VALUES (2025, 1, 'beta-driver', 'planned-team', 3, 'RACE_QUALIFYING')`);
        const duplicateReference: PlannedReferenceDatabase = {
          qualifying_classification: [
            ...reference.qualifying_classification!,
            { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 3, classification_status: 'classified' }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows).toEqual([{
          count_qualifying_position: 4, [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for scalar recorded race-position counts and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(scalarRaceCountPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1 },
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2 }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{ count_finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingPlan: any = structuredClone(scalarRaceCountPlan());
    missingPlan.root.input.input.input.input.predicates[0].value = 2024;
    const missingCore = lowerPlannedF1QL(missingPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, { event_classification: [] }));
    expect(missingRows).toEqual([{ count_finishing_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { position: null, expectedCount: 1, expectedIntegrity: true },
        { position: 1, expectedCount: 2, expectedIntegrity: true },
        { position: 30, expectedCount: 2, expectedIntegrity: true },
        { position: 0, expectedCount: 2, expectedIntegrity: false },
        { position: 31, expectedCount: 2, expectedIntegrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE race_data SET position_number = $1 WHERE race_id = 9801 AND type = $2 AND driver_id = $3',
            [mutation.position, 'race', 'beta_driver']
          );
          const mutatedReference: PlannedReferenceDatabase = {
            event_classification: [
              reference.event_classification![0],
              { ...reference.event_classification![1], finishing_position: mutation.position }
            ]
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([{
            count_finishing_position: mutation.expectedCount,
            [PLANNED_INTEGRITY_FIELD]: mutation.expectedIntegrity
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      await client.query('BEGIN');
      try {
        await client.query('UPDATE race_data SET position_number = NULL WHERE race_id = 9801 AND type = $1', ['race']);
        const allNullReference: PlannedReferenceDatabase = {
          event_classification: reference.event_classification!.map(row => ({
            ...row, finishing_position: null
          }))
        };
        const allNullRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(allNullRows).toEqual(interpretPlannedF1QL(core, allNullReference));
        expect(allNullRows).toEqual([{
          count_finishing_position: 0, [PLANNED_INTEGRITY_FIELD]: true
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query('ALTER TABLE race_data DROP CONSTRAINT race_data_pkey');
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number)
          VALUES (9801, 'race', 'beta_driver', 'planned-team', 3, 3)`);
        const duplicateReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 3 }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows).toEqual([{
          count_finishing_position: 3, [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for one-driver scalar race counts with selected presence and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(scalarRaceCountPlan('alpha-driver'));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 1 },
        { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 2 }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{ count_finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingCore = lowerPlannedF1QL(scalarRaceCountPlan('missing-driver'));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{ count_finishing_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { driver: 'alpha_driver', position: null, count: 0, integrity: true },
        { driver: 'alpha_driver', position: 30, count: 1, integrity: true },
        { driver: 'alpha_driver', position: 0, count: 1, integrity: false },
        { driver: 'alpha_driver', position: 31, count: 1, integrity: false },
        { driver: 'beta_driver', position: null, count: 1, integrity: true },
        { driver: 'beta_driver', position: 1, count: 1, integrity: true },
        { driver: 'beta_driver', position: 0, count: 1, integrity: false },
        { driver: 'beta_driver', position: 31, count: 1, integrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE race_data SET position_number = $1 WHERE race_id = 9801 AND type = $2 AND driver_id = $3',
            [mutation.position, 'race', mutation.driver]
          );
          const mutatedReference: PlannedReferenceDatabase = {
            event_classification: reference.event_classification!.map(row =>
              row.driver_id === mutation.driver.replace('_', '-')
                ? { ...row, finishing_position: mutation.position }
                : row)
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([{
            count_finishing_position: mutation.count,
            [PLANNED_INTEGRITY_FIELD]: mutation.integrity
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      await client.query('BEGIN');
      try {
        await client.query('ALTER TABLE race_data DROP CONSTRAINT race_data_pkey');
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number)
          VALUES (9801, 'race', 'beta_driver', 'planned-team', 3, 3)`);
        const duplicateReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'beta-driver', finishing_position: 3 }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows).toEqual([{
          count_finishing_position: 1, [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }

      await client.query('BEGIN');
      try {
        await client.query('ALTER TABLE race_data DROP CONSTRAINT race_data_pkey');
        await client.query(`INSERT INTO race_data
          (race_id, type, driver_id, constructor_id, position_display_order, position_number)
          VALUES (9801, 'race', 'alpha_driver', 'planned-team', 3, 3)`);
        const duplicateReference: PlannedReferenceDatabase = {
          event_classification: [
            ...reference.event_classification!,
            { season: 2025, round: 1, driver_id: 'alpha-driver', finishing_position: 3 }
          ]
        };
        const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
        expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
        expect(duplicateRows).toEqual([{
          count_finishing_position: 2, [PLANNED_INTEGRITY_FIELD]: false
        }]);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('matches PostgreSQL for one-driver scalar qualifying counts with selected presence and source-wide integrity', async () => {
    const core = lowerPlannedF1QL(scalarQualifyingCountPlan(undefined, 'alpha-driver'));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
        { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
        { season: 2025, round: 2, driver_id: 'outside-driver', qualifying_position: 11, classification_status: 'classified' }
      ]
    };
    const rows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(rows).toEqual(interpretPlannedF1QL(core, reference));
    expect(rows).toEqual([{ count_qualifying_position: 1, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingCore = lowerPlannedF1QL(scalarQualifyingCountPlan(undefined, 'missing-driver'));
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);

    const client = await pool.connect();
    try {
      for (const mutation of [
        { driver: 'alpha_driver', position: null, count: 0, integrity: true },
        { driver: 'alpha_driver', position: 30, count: 1, integrity: true },
        { driver: 'alpha_driver', position: 0, count: 1, integrity: false },
        { driver: 'alpha_driver', position: 31, count: 1, integrity: false },
        { driver: 'beta_driver', position: null, count: 1, integrity: true },
        { driver: 'beta_driver', position: 1, count: 1, integrity: true },
        { driver: 'beta_driver', position: 0, count: 1, integrity: false },
        { driver: 'beta_driver', position: 31, count: 1, integrity: false }
      ] as const) {
        await client.query('BEGIN');
        try {
          await client.query(
            'UPDATE qualifying_results SET qualifying_position = $1 WHERE season = 2025 AND round = 1 AND driver_id = $2',
            [mutation.position, mutation.driver]
          );
          const mutatedReference: PlannedReferenceDatabase = {
            qualifying_classification: reference.qualifying_classification!.map(row =>
              row.driver_id === mutation.driver.replace('_', '-')
                ? { ...row, qualifying_position: mutation.position }
                : row)
          };
          const mutatedRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(mutatedRows).toEqual(interpretPlannedF1QL(core, mutatedReference));
          expect(mutatedRows).toEqual([{
            count_qualifying_position: mutation.count,
            [PLANNED_INTEGRITY_FIELD]: mutation.integrity
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }

      for (const driver of ['beta-driver', 'alpha-driver']) {
        await client.query('BEGIN');
        try {
          await client.query(`INSERT INTO qualifying_results
            (season, round, driver_id, team_id, qualifying_position, session_type)
            VALUES (2025, 1, $1, 'planned-team', 3, 'RACE_QUALIFYING')`, [driver]);
          const duplicateReference: PlannedReferenceDatabase = {
            qualifying_classification: [
              ...reference.qualifying_classification!,
              { season: 2025, round: 1, driver_id: driver, qualifying_position: 3, classification_status: 'classified' }
            ]
          };
          const duplicateRows = (await client.query(compiled.sql, compiled.params)).rows;
          expect(duplicateRows).toEqual(interpretPlannedF1QL(core, duplicateReference));
          expect(duplicateRows).toEqual([{
            count_qualifying_position: driver === 'alpha-driver' ? 2 : 1,
            [PLANNED_INTEGRITY_FIELD]: false
          }]);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });

  it('preserves valid source integrity for a scalar zero-count result', async () => {
    const core = lowerPlannedF1QL(scalarQualifyingCountPlan('dns'));
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      qualifying_classification: [
        { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: true }]);

    const missingDriverPlan: any = structuredClone(scalarQualifyingCountPlan('dns'));
    missingDriverPlan.root.input.input.input.input.predicates.splice(1, 0,
      predicate('qualifying_classification', 'driver_id', 'missing-driver'));
    const missingCore = lowerPlannedF1QL(missingDriverPlan);
    const missingCompiled = compilePlannedF1QL(missingCore);
    const missingRows = (await pool.query(missingCompiled.sql, missingCompiled.params)).rows;
    expect(missingRows).toEqual(interpretPlannedF1QL(missingCore, reference));
    expect(missingRows).toEqual([{ count_qualifying_position: 0, [PLANNED_INTEGRITY_FIELD]: false }]);
  });

  it('propagates relevant-position corruption globally before ranking and limit', async () => {
    const plan: any = structuredClone(qualifyingRankPlan());
    plan.root.count = 1;
    plan.root.input.input.input.input.predicates.unshift(
      predicate('qualifying_classification', 'driver_id', 'alpha-driver'));
    const core = lowerPlannedF1QL(plan);
    const compiled = compilePlannedF1QL(core);
    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO qualifying_results
        (season, round, driver_id, team_id, qualifying_position, session_type)
        VALUES (2025, 1, 'gamma_driver', 'planned-team', 2, 'RACE_QUALIFYING')`);
      const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
      const reference: PlannedReferenceDatabase = {
        qualifying_classification: [
          { season: 2025, round: 1, driver_id: 'alpha-driver', qualifying_position: 1, classification_status: 'classified' },
          { season: 2025, round: 1, driver_id: 'beta-driver', qualifying_position: 2, classification_status: 'classified' },
          { season: 2025, round: 1, driver_id: 'gamma-driver', qualifying_position: 2, classification_status: 'classified' }
        ]
      };
      expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
      expect(sqlRows).toHaveLength(1);
      expect(sqlRows[0][PLANNED_INTEGRITY_FIELD]).toBe(false);
    } finally {
      await pool.query('ROLLBACK');
    }
  });

  it('matches PostgreSQL for the typed many-to-one metadata join and exposes duplicate-target failure', async () => {
    const core = lowerPlannedF1QL(raceMetadataPlan());
    const compiled = compilePlannedF1QL(core);
    const reference: PlannedReferenceDatabase = {
      event_classification: [
        { season: 2025, round: 1, driver_id: 'beta-driver', team_id: 'planned-team', finishing_position: 2, points: '9007199254740992', classification_status: 'classified', status_reason: null },
        { season: 2025, round: 1, driver_id: 'alpha-driver', team_id: 'planned-team', finishing_position: 1, points: '9007199254740993', classification_status: 'classified', status_reason: null }
      ],
      event_metadata: [
        { season: 2025, round: 1, event_id: 'planned-gp', event_name: 'Formula 1 Planned Grand Prix', circuit_id: 'planned-circuit', date: '2025-01-01' }
      ]
    };
    const sqlRows = (await pool.query(compiled.sql, compiled.params)).rows;
    expect(sqlRows).toEqual(interpretPlannedF1QL(core, reference));
    expect(sqlRows.map(row => row[PLANNED_INTEGRITY_FIELD])).toEqual([true, true]);

    for (const selected of ['alpha-driver', ['alpha-driver', 'beta-driver']] as const) {
      const selectedCore = lowerPlannedF1QL(selectedRaceMetadataPlan(selected));
      const selectedCompiled = compilePlannedF1QL(selectedCore);
      const selectedRows = (await pool.query(selectedCompiled.sql, selectedCompiled.params)).rows;
      expect(selectedRows).toEqual(interpretPlannedF1QL(selectedCore, reference));
      expect(selectedRows).toHaveLength(typeof selected === 'string' ? 1 : 2);
      expect(selectedRows.every(row => row.date === '2025-01-01' && row[PLANNED_INTEGRITY_FIELD] === true)).toBe(true);
    }

    for (const selected of ['alpha-driver', ['alpha-driver', 'beta-driver']] as const) {
      const selectedCore = lowerPlannedF1QL(selectedQualifyingMetadataPlan(selected));
      const selectedCompiled = compilePlannedF1QL(selectedCore);
      const qualifyingReference: PlannedReferenceDatabase = {
        qualifying_classification: [
          { season: 2025, round: 1, driver_id: 'alpha-driver', team_id: 'planned-team', qualifying_position: 1, classification_status: 'classified' },
          { season: 2025, round: 1, driver_id: 'beta-driver', team_id: 'planned-team', qualifying_position: 2, classification_status: 'classified' }
        ],
        event_metadata: reference.event_metadata
      };
      const selectedRows = (await pool.query(selectedCompiled.sql, selectedCompiled.params)).rows;
      expect(selectedRows).toEqual(interpretPlannedF1QL(selectedCore, qualifyingReference));
      expect(selectedRows).toHaveLength(typeof selected === 'string' ? 1 : 2);
      expect(selectedRows.every(row => row.date === '2025-01-01' && row[PLANNED_INTEGRITY_FIELD] === true)).toBe(true);
    }

    const missingNamePlan: any = structuredClone(raceMetadataPlan());
    for (const branch of [missingNamePlan.root.input.input.input.left, missingNamePlan.root.input.input.input.right]) {
      branch.predicates.find((item: any) => item.concept.concept_id === 'round').value = 2;
    }
    const missingNameCore = lowerPlannedF1QL(missingNamePlan);
    const missingNameCompiled = compilePlannedF1QL(missingNameCore);
    const missingNameReference: PlannedReferenceDatabase = {
      event_classification: [{
        season: 2025, round: 2, driver_id: 'alpha-driver', team_id: 'planned-team',
        finishing_position: 1, points: 1, classification_status: 'classified', status_reason: null
      }],
      event_metadata: [{
        season: 2025, round: 2, event_id: 'empty-circuit', event_name: null,
        circuit_id: 'empty-circuit', date: '2025-02-01'
      }]
    };
    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race_data
        (race_id, type, driver_id, constructor_id, position_display_order, position_number, race_points)
        VALUES (9802, 'race', 'alpha_driver', 'planned-team', 1, 1, 1)`);
      const missingNameRows = (await pool.query(missingNameCompiled.sql, missingNameCompiled.params)).rows;
      expect(missingNameRows).toEqual(interpretPlannedF1QL(missingNameCore, missingNameReference));
      expect(missingNameRows).toEqual([expect.objectContaining({
        event_name: null, circuit_id: 'empty-circuit', [PLANNED_INTEGRITY_FIELD]: false
      })]);
    } finally {
      await pool.query('ROLLBACK');
    }

    await pool.query('BEGIN');
    try {
      await pool.query(`INSERT INTO race (id, year, round, grand_prix_id, circuit_id, official_name, date)
        VALUES (9804, 2025, 1, 'planned_gp', 'other-circuit', 'DUPLICATE PLANNED EVENT', '2025-01-02')`);
      const duplicateRows = (await pool.query(compiled.sql, compiled.params)).rows;
      expect(duplicateRows).toHaveLength(4);
      expect(duplicateRows.every(row => row[PLANNED_INTEGRITY_FIELD] === false)).toBe(true);
    } finally {
      await pool.query('ROLLBACK');
    }
  });
});
