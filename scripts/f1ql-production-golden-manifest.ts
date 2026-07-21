import { F1QLProgram } from '../src/f1ql/ast';

export interface ProductionGoldenCase {
  id: string;
  authority: {
    publisher: 'FIA';
    document: string;
    url: string;
  };
  program: F1QLProgram;
  expected_facts: Array<Record<string, unknown>>;
}

// These are completed-event facts from the FIA final classification, not live standings or pace data.
export const productionGoldenManifest: readonly ProductionGoldenCase[] = [
  {
    id: '2024-bahrain-race-winner',
    authority: {
      publisher: 'FIA',
      document: '2024 Bahrain Grand Prix Final Race Classification',
      url: 'https://www.fia.com/documents/season/season-2024-2043/championships/formula-1-world-championship-14'
    },
    program: {
      version: 1,
      root: {
        op: 'event_classification',
        season: 2024,
        round: 1,
        limit: 1,
        filters: { driver_id: 'max-verstappen' }
      }
    },
    expected_facts: [{
      driver_id: 'max-verstappen',
      finishing_position: 1,
      points: 25,
      classification_status: 'classified'
    }]
  },
  {
    id: '2024-bahrain-race-metadata',
    authority: {
      publisher: 'FIA',
      document: '2024 Bahrain Grand Prix Final Race Classification',
      url: 'https://www.fia.com/documents/season/season-2024-2043/championships/formula-1-world-championship-14'
    },
    program: {
      version: 1,
      root: {
        op: 'event_metadata',
        season: 2024,
        round: 1,
        session_scope: 'race'
      }
    },
    expected_facts: [{
      event_name: 'Bahrain Grand Prix',
      date: '2024-03-02',
      session_scope: 'race'
    }]
  }
];

if (productionGoldenManifest.length > 3) {
  throw new Error('Production golden manifest exceeds its three-program bound');
}
