export interface DenotationStandingRow {
  readonly season: number;
  readonly driver_id: string;
  readonly championship_position: number | null;
  readonly championship_won: boolean | null;
  readonly points: string | null;
}

export interface DenotationClassificationRow {
  readonly driver_id: string;
  readonly team_id: string | null;
  readonly finishing_position: number | null;
  readonly points: string | null;
  readonly classification_status: 'classified' | 'dnf' | 'dns';
  readonly status_reason: string | null;
}

export interface DenotationEventRow {
  readonly season: number;
  readonly round: number;
  readonly event_id: string | null;
  readonly event_name: string | null;
  readonly circuit_id: string | null;
  readonly date: string | null;
  readonly classifications: readonly DenotationClassificationRow[];
}

export interface DenotationQualifyingRow {
  readonly season: number;
  readonly round: number;
  readonly driver_id: string;
  readonly team_id: string;
  readonly qualifying_position: number | null;
  readonly best_time_ms: number | null;
  readonly best_session: string | null;
  readonly eliminated_in_round: string | null;
  readonly classification_status: 'classified' | 'dnf' | 'dns';
}

export interface PlannedDenotationPopulation {
  readonly id: string;
  readonly traits: readonly string[];
  readonly standings: readonly DenotationStandingRow[];
  readonly events: readonly DenotationEventRow[];
  readonly qualifying: readonly DenotationQualifyingRow[];
}

const classified = (
  driver_id: string,
  finishing_position: number,
  points: string,
  team_id = 'team-a'
): DenotationClassificationRow => ({
  driver_id,
  team_id,
  finishing_position,
  points,
  classification_status: 'classified',
  status_reason: null
});

const qualifying = (
  season: number,
  round: number,
  driver_id: string,
  qualifying_position: number | null,
  classification_status: DenotationQualifyingRow['classification_status'] = 'classified'
): DenotationQualifyingRow => ({
  season,
  round,
  driver_id,
  team_id: 'team-a',
  qualifying_position,
  best_time_ms: qualifying_position === null ? null : 80_000 + round * 100 + qualifying_position,
  best_session: null,
  eliminated_in_round: null,
  classification_status
});

export const plannedDenotationPopulations: readonly PlannedDenotationPopulation[] = [
  {
    id: 'metric-source-divergence-ties-and-duplicates',
    traits: [
      'duplicate-logical-qualifying-row',
      'metric-source-divergence',
      'missing-driver-session-row',
      'null-position',
      'sparse-prior-season',
      'tied-points',
      'tied-positions'
    ],
    standings: [
      { season: 2025, driver_id: 'lando-norris', championship_position: 2, championship_won: false, points: '315' },
      { season: 2025, driver_id: 'oscar-piastri', championship_position: 1, championship_won: true, points: '315' },
      { season: 2025, driver_id: 'reserve-driver', championship_position: 9, championship_won: false, points: '1' },
      { season: 2024, driver_id: 'lando-norris', championship_position: 6, championship_won: false, points: '7' }
    ],
    events: [
      {
        season: 2025,
        round: 1,
        event_id: 'alpha-circuit',
        event_name: 'Alpha Grand Prix',
        circuit_id: 'alpha-circuit',
        date: '2025-03-02',
        classifications: [
          classified('lando-norris', 2, '25'),
          classified('oscar-piastri', 1, '10'),
          {
            driver_id: 'reserve-driver', team_id: 'team-b', finishing_position: null, points: '0',
            classification_status: 'dnf', status_reason: 'engine'
          }
        ]
      },
      {
        season: 2025,
        round: 2,
        event_id: 'bravo-circuit',
        event_name: 'Bravo Grand Prix',
        circuit_id: 'bravo-circuit',
        date: '2025-03-16',
        classifications: [classified('lando-norris', 1, '20'), classified('oscar-piastri', 1, '0')]
      },
      {
        season: 2025,
        round: 3,
        event_id: 'charlie-circuit',
        event_name: 'Charlie Grand Prix',
        circuit_id: 'charlie-circuit',
        date: '2025-03-30',
        classifications: [classified('lando-norris', 5, '15')]
      },
      {
        season: 2024,
        round: 1,
        event_id: 'prior-circuit',
        event_name: 'Prior Grand Prix',
        circuit_id: 'prior-circuit',
        date: '2024-03-03',
        classifications: [classified('lando-norris', 7, '7')]
      }
    ],
    qualifying: [
      qualifying(2025, 1, 'lando-norris', 3),
      qualifying(2025, 1, 'oscar-piastri', 1),
      qualifying(2025, 1, 'reserve-driver', null, 'dns'),
      qualifying(2025, 2, 'lando-norris', 1),
      qualifying(2025, 2, 'oscar-piastri', 1),
      qualifying(2025, 3, 'oscar-piastri', 2),
      qualifying(2025, 4, 'lando-norris', 4),
      qualifying(2025, 4, 'lando-norris', 4),
      qualifying(2024, 1, 'lando-norris', 1)
    ]
  },
  {
    id: 'sparse-missing-rows-and-incomplete-metadata',
    traits: [
      'duplicate-event-metadata',
      'incomplete-event-metadata',
      'incomplete-qualifying-session-metadata',
      'metric-source-divergence',
      'missing-driver-event-row',
      'null-points',
      'null-position',
      'sparse-season'
    ],
    standings: [
      { season: 2025, driver_id: 'lando-norris', championship_position: 1, championship_won: true, points: '80' },
      { season: 2025, driver_id: 'oscar-piastri', championship_position: 2, championship_won: false, points: '70' },
      { season: 2025, driver_id: 'reserve-driver', championship_position: 8, championship_won: false, points: null },
      { season: 2024, driver_id: 'lando-norris', championship_position: 4, championship_won: false, points: '10' },
      { season: 2024, driver_id: 'oscar-piastri', championship_position: 5, championship_won: false, points: '9' }
    ],
    events: [
      {
        season: 2025,
        round: 1,
        event_id: null,
        event_name: null,
        circuit_id: null,
        date: null,
        classifications: [
          classified('lando-norris', 2, '8'),
          {
            driver_id: 'oscar-piastri', team_id: 'team-a', finishing_position: null, points: '0',
            classification_status: 'dnf', status_reason: 'gearbox'
          }
        ]
      },
      {
        season: 2025,
        round: 1,
        event_id: null,
        event_name: null,
        circuit_id: null,
        date: null,
        classifications: []
      },
      {
        season: 2025,
        round: 2,
        event_id: 'sparse-circuit',
        event_name: 'Sparse Grand Prix',
        circuit_id: 'sparse-circuit',
        date: '2025-04-06',
        classifications: [classified('lando-norris', 4, '6')]
      },
      {
        season: 2025,
        round: 3,
        event_id: 'late-circuit',
        event_name: 'Late Grand Prix',
        circuit_id: 'late-circuit',
        date: '2025-04-20',
        classifications: [classified('oscar-piastri', 3, '15'), classified('reserve-driver', 5, '2', 'team-b')]
      },
      {
        season: 2024,
        round: 1,
        event_id: 'prior-two-circuit',
        event_name: 'Prior Two Grand Prix',
        circuit_id: 'prior-two-circuit',
        date: '2024-04-07',
        classifications: [classified('lando-norris', 5, '5'), classified('oscar-piastri', 4, '6')]
      }
    ],
    qualifying: [
      qualifying(2025, 1, 'lando-norris', 5),
      qualifying(2025, 1, 'oscar-piastri', 2),
      qualifying(2025, 1, 'reserve-driver', null, 'dns'),
      qualifying(2025, 2, 'oscar-piastri', 1),
      qualifying(2025, 3, 'lando-norris', null, 'dns'),
      qualifying(2024, 1, 'lando-norris', 6),
      qualifying(2024, 2, 'lando-norris', 4)
    ]
  }
] as const;
