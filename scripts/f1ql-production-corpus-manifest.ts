import { F1QLProgram } from '../src/f1ql/ast';
import { goldenCorpus } from '../tests/fixtures/f1ql-golden-corpus';
import { resolveChampionshipScoringRules } from '../src/scoring/rules';

export type ProductionCorpusDisposition = 'fixture_only' | 'production_runnable_structural' | 'authoritative_factual';

export interface ProductionCorpusAuditCase {
  question: string;
  disposition: ProductionCorpusDisposition;
  runner_action: 'skipped_fixture_only' | 'not_selected_bounded_manifest';
  reason: string;
}

export interface ProductionCorpusCase {
  id: string;
  disposition: 'production_runnable_structural' | 'authoritative_factual';
  required_relation: string;
  program: F1QLProgram;
  authority?: {
    publisher: 'FIA' | 'Formula 1';
    document: string;
    url: string;
  };
  scoring_rule_id?: string;
  expected_facts?: Array<Record<string, unknown>>;
}

// Championship totals are read only from the season standings authority, never
// derived by adding race-classification points.
function finalDriverStandingProgram(season: number, driverId: string): F1QLProgram {
  return {
    version: 1,
    root: {
      op: 'aggregate',
      input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season, driver_id: driverId } },
      group_by: ['driver_id'],
      measures: [
        { as: 'points', function: 'max', field: 'points' },
        { as: 'championship_position', function: 'max', field: 'championship_position' }
      ]
    }
  };
}

const STRUCTURAL_REASONS: Record<string, string> = {
  standings: 'Canonical standings view; results are structural only because the fixture is synthetic.',
  event_classification: 'Canonical race-classification view; results are structural only because the fixture is synthetic.',
  qualifying_classification: 'Canonical qualifying-classification view; results are structural only because the fixture is synthetic.',
  event_metadata: 'Canonical event-metadata view; results are structural only because the fixture is synthetic.'
};

export const productionCorpusAudit: readonly ProductionCorpusAuditCase[] = goldenCorpus.map((testCase) => {
  if (testCase.expected) {
    return { question: testCase.question, disposition: 'fixture_only', runner_action: 'skipped_fixture_only', reason: 'Deliberate schema, validation, or fixture-execution rejection.' };
  }
  const root = (testCase.program as F1QLProgram).root;
  if (root.op === 'pace_summary' || root.op === 'pace_delta') {
    return { question: testCase.question, disposition: 'fixture_only', runner_action: 'skipped_fixture_only', reason: 'Lap pace is source-dependent and the 2025 fixture does not prove production lap coverage.' };
  }
  const source = root.op === 'rank' || root.op === 'aggregate' ? 'standings' : root.op;
  return { question: testCase.question, disposition: 'production_runnable_structural', runner_action: 'not_selected_bounded_manifest', reason: STRUCTURAL_REASONS[source] };
});

if (productionCorpusAudit.length !== 100) {
  throw new Error(`Production corpus audit must classify 100 cases; found ${productionCorpusAudit.length}`);
}

// This is intentionally a literal, bounded production projection rather than a loop over fixture data.
export const productionCorpusManifest: readonly ProductionCorpusCase[] = [
  {
    id: '2025-standings-structural',
    disposition: 'production_runnable_structural',
    required_relation: 'f1ql.driver_standings',
    program: { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'max', field: 'points' }] } }
  },
  {
    id: '2025-race-classification-structural',
    disposition: 'production_runnable_structural',
    required_relation: 'f1ql.event_classification',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1 } }
  },
  {
    id: '2025-qualifying-classification-structural',
    disposition: 'production_runnable_structural',
    required_relation: 'f1ql.qualifying_classification',
    program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1 } }
  },
  {
    id: '1950-british-grand-prix-metadata',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_metadata',
    authority: { publisher: 'FIA', document: 'FIA Records Lists (1950-1959), 1950 season archive', url: 'https://www.fia.com/records-lists-1950-1959' },
    scoring_rule_id: 'historical-1950-1953',
    program: { version: 1, root: { op: 'event_metadata', season: 1950, round: 1, session_scope: 'race' } },
    expected_facts: [{ event_name: 'British Grand Prix', date: '1950-05-13', session_scope: 'race' }]
  },
  {
    id: '2014-abu-dhabi-race-winner',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: 'Hamilton wins in Abu Dhabi to take 2014 F1 title', url: 'https://www.fia.com/news/hamilton-wins-abu-dhabi-take-2014-f1-title' },
    scoring_rule_id: 'historical-2014-double-final',
    program: { version: 1, root: { op: 'event_classification', season: 2014, round: 19, limit: 1, filters: { driver_id: 'lewis-hamilton' } } },
    expected_facts: [{ driver_id: 'lewis-hamilton', finishing_position: 1, points: 50, classification_status: 'classified' }]
  },
  {
    id: '2019-australia-race-winner',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2019 Australian Grand Prix Final Race Classification, Document 31', url: 'https://www.fia.com/sites/default/files/doc_31_-_2019_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'historical-2019-2020-fastest-lap',
    program: { version: 1, root: { op: 'event_classification', season: 2019, round: 1, limit: 1, filters: { driver_id: 'valtteri-bottas' } } },
    expected_facts: [{ driver_id: 'valtteri-bottas', finishing_position: 1, points: 26, classification_status: 'classified' }]
  },
  {
    id: '2021-belgium-race-classification',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2021 Belgian Grand Prix Final Race Classification, Document 43', url: 'https://www.fia.com/sites/default/files/doc_43_-_2021_belgian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2021-sprint-trial',
    program: { version: 1, root: { op: 'event_classification', season: 2021, round: 12, limit: 1, filters: { driver_id: 'max-verstappen' } } },
    expected_facts: [{ driver_id: 'max-verstappen', finishing_position: 1, points: 12.5, classification_status: 'classified' }]
  },
  {
    id: '2022-austria-race-winner',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2022 Austrian Grand Prix Final Race Classification, Document 78', url: 'https://www.fia.com/sites/default/files/doc_78_-_2022_austrian_grand_prix_-_final_race_classification_0.pdf' },
    scoring_rule_id: 'fia-2022-2024-sprint-top-eight',
    program: { version: 1, root: { op: 'event_classification', season: 2022, round: 11, limit: 1, filters: { driver_id: 'charles-leclerc' } } },
    expected_facts: [{ driver_id: 'charles-leclerc', finishing_position: 1, points: 25, classification_status: 'classified' }]
  },
  {
    id: '2024-bahrain-race-winner',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2024 Bahrain Grand Prix Final Race Classification', url: 'https://www.fia.com/documents/season/season-2024-2043/championships/formula-1-world-championship-14' },
    scoring_rule_id: 'fia-2022-2024-sprint-top-eight',
    program: { version: 1, root: { op: 'event_classification', season: 2024, round: 1, limit: 1, filters: { driver_id: 'max-verstappen' } } },
    expected_facts: [{ driver_id: 'max-verstappen', finishing_position: 1, points: 26, classification_status: 'classified' }]
  },
  {
    id: '2024-bahrain-race-metadata',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_metadata',
    authority: { publisher: 'FIA', document: '2024 Bahrain Grand Prix Final Race Classification', url: 'https://www.fia.com/documents/season/season-2024-2043/championships/formula-1-world-championship-14' },
    program: { version: 1, root: { op: 'event_metadata', season: 2024, round: 1, session_scope: 'race' } },
    expected_facts: [{ event_name: 'Bahrain Grand Prix', date: '2024-03-02', session_scope: 'race' }]
  },
  {
    id: '2025-driver-champion-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Championship Points, Document 56', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: finalDriverStandingProgram(2025, 'lando-norris'),
    expected_facts: [{ driver_id: 'lando-norris', points: 423, championship_position: 1 }]
  },
  {
    id: '2025-driver-vice-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Championship Points, Document 56', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: finalDriverStandingProgram(2025, 'max-verstappen'),
    expected_facts: [{ driver_id: 'max-verstappen', points: 421, championship_position: 2 }]
  },
  {
    id: '2025-driver-third-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Championship Points, Document 56', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: finalDriverStandingProgram(2025, 'oscar-piastri'),
    expected_facts: [{ driver_id: 'oscar-piastri', points: 410, championship_position: 3 }]
  },
  {
    id: '2025-driver-zero-points-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Championship Points, Document 56', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: finalDriverStandingProgram(2025, 'franco-colapinto'),
    expected_facts: [{ driver_id: 'franco-colapinto', points: 0, championship_position: 20 }]
  },
  {
    id: '2014-driver-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2014 Classifications, Drivers Championship', url: 'https://www.fia.com/events/fia-formula-one-world-championship/season-2014/2014-classifications' },
    scoring_rule_id: 'historical-2014-double-final',
    program: finalDriverStandingProgram(2014, 'lewis-hamilton'),
    expected_facts: [{ driver_id: 'lewis-hamilton', points: 384, championship_position: 1 }]
  },
  {
    id: '2019-driver-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2019 Classifications, Drivers Championship', url: 'https://www.fia.com/events/fia-formula-one-world-championship/season-2019/2019-classifications' },
    scoring_rule_id: 'historical-2019-2020-fastest-lap',
    program: finalDriverStandingProgram(2019, 'lewis-hamilton'),
    expected_facts: [{ driver_id: 'lewis-hamilton', points: 413, championship_position: 1 }]
  },
  {
    id: '2021-driver-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2021 Abu Dhabi Grand Prix Championship Points, Document 60', url: 'https://www.fia.com/sites/default/files/decision-document/2021%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf' },
    scoring_rule_id: 'fia-2021-sprint-trial',
    program: finalDriverStandingProgram(2021, 'max-verstappen'),
    expected_facts: [{ driver_id: 'max-verstappen', points: 395.5, championship_position: 1 }]
  },
  {
    id: '2022-driver-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2022 Abu Dhabi Grand Prix Championship Points, Document 38', url: 'https://www.fia.com/sites/default/files/decision-document/2022%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf' },
    scoring_rule_id: 'fia-2022-2024-sprint-top-eight',
    program: finalDriverStandingProgram(2022, 'max-verstappen'),
    expected_facts: [{ driver_id: 'max-verstappen', points: 454, championship_position: 1 }]
  },
  {
    id: '2024-driver-champion-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2024 Abu Dhabi Grand Prix Championship Points, Document 58', url: 'https://www.fia.com/sites/default/files/decision-document/2024%20Abu%20Dhabi%20Grand%20Prix%20-%20Championship%20Points.pdf' },
    scoring_rule_id: 'fia-2022-2024-sprint-top-eight',
    program: finalDriverStandingProgram(2024, 'max-verstappen'),
    expected_facts: [{ driver_id: 'max-verstappen', points: 437, championship_position: 1 }]
  },
  {
    id: '2025-australia-qualifying-pole',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.qualifying_classification',
    authority: { publisher: 'Formula 1', document: 'Norris storms to pole position for the Australian Grand Prix', url: 'https://www.formula1.com/en/latest/article/norris-storms-to-pole-position-for-the-australian-grand-prix-ahead-of.7xW094Sd0b5e2qHIvAaf3s' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'lando-norris' } } },
    expected_facts: [{ driver_id: 'lando-norris', qualifying_position: 1, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-race-second',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Race Classification', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'max-verstappen' } } },
    expected_facts: [{ driver_id: 'max-verstappen', finishing_position: 2, points: 18, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-race-third',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Race Classification', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'george-russell' } } },
    expected_facts: [{ driver_id: 'george-russell', finishing_position: 3, points: 15, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-race-dnf',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Race Classification', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'fernando-alonso', classification_status: ['dnf'] } } },
    expected_facts: [{ driver_id: 'fernando-alonso', finishing_position: null, classification_status: 'dnf' }]
  },
  {
    id: '2025-australia-race-winner-no-fastest-lap-bonus',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Race Classification, Document 48', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'lando-norris' } } },
    expected_facts: [{ driver_id: 'lando-norris', finishing_position: 1, points: 25, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-race-sainz-zero-lap-dnf',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Race Classification, Document 48', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'carlos-sainz' } } },
    expected_facts: [{ driver_id: 'carlos-sainz', finishing_position: null, classification_status: 'dnf' }]
  },
  {
    id: '2025-australia-qualifying-second',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.qualifying_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Qualifying Classification', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_qualifying_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'oscar-piastri' } } },
    expected_facts: [{ driver_id: 'oscar-piastri', qualifying_position: 2, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-qualifying-third',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.qualifying_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Qualifying Classification', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_qualifying_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'max-verstappen' } } },
    expected_facts: [{ driver_id: 'max-verstappen', qualifying_position: 3, classification_status: 'classified' }]
  },
  {
    id: '2025-australia-qualifying-bearman-dns',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.qualifying_classification',
    authority: { publisher: 'FIA', document: '2025 Australian Grand Prix Final Qualifying Classification, Document 26', url: 'https://www.fia.com/system/files/decision-document/2025_australian_grand_prix_-_final_qualifying_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'qualifying_classification', season: 2025, round: 1, limit: 1, filters: { driver_id: 'oliver-bearman', classification_status: ['dns'] } } },
    expected_facts: [{ driver_id: 'oliver-bearman', qualifying_position: null, classification_status: 'dns' }]
  },
  {
    id: '2025-abu-dhabi-race-second-nonwinner',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Final Race Classification, Document 55', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 24, limit: 1, filters: { driver_id: 'oscar-piastri' } } },
    expected_facts: [{ driver_id: 'oscar-piastri', finishing_position: 2, points: 18, classification_status: 'classified' }]
  },
  {
    id: '2025-abu-dhabi-race-colapinto-zero-points',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_classification',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Final Race Classification, Document 55', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_final_race_classification.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_classification', season: 2025, round: 24, limit: 1, filters: { driver_id: 'franco-colapinto' } } },
    expected_facts: [{ driver_id: 'franco-colapinto', finishing_position: 20, points: 0, classification_status: 'classified' }]
  },
  {
    id: '2025-driver-fourth-final-standing',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.driver_standings',
    authority: { publisher: 'FIA', document: '2025 Abu Dhabi Grand Prix Championship Points, Document 56', url: 'https://www.fia.com/system/files/decision-document/2025_abu_dhabi_grand_prix_-_championship_points.pdf' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: finalDriverStandingProgram(2025, 'george-russell'),
    expected_facts: [{ driver_id: 'george-russell', points: 319, championship_position: 4 }]
  },
  {
    id: '2025-australia-event-metadata',
    disposition: 'authoritative_factual',
    required_relation: 'f1ql.event_metadata',
    authority: { publisher: 'Formula 1', document: '2025 Australian Grand Prix qualifying report', url: 'https://www.formula1.com/en/latest/article/norris-storms-to-pole-position-for-the-australian-grand-prix-ahead-of.7xW094Sd0b5e2qHIvAaf3s' },
    scoring_rule_id: 'fia-2025-no-fastest-lap-bonus',
    program: { version: 1, root: { op: 'event_metadata', season: 2025, round: 1, session_scope: 'qualifying' } },
    expected_facts: [{ event_name: 'Australian Grand Prix', date: '2025-03-16', session_scope: 'qualifying' }]
  }
];

for (const testCase of productionCorpusManifest) {
  if (!testCase.scoring_rule_id) {
    continue;
  }
  const root = testCase.program.root;
  const season = root.op === 'aggregate'
    ? root.input.op === 'filter' && typeof root.input.where.season === 'number' ? root.input.where.season : undefined
    : root.op === 'event_classification' || root.op === 'qualifying_classification' || root.op === 'event_metadata'
      ? root.season
      : undefined;
  const resolution = season === undefined ? undefined : resolveChampionshipScoringRules(season);
  if (resolution?.status !== 'supported' || resolution.rules.id !== testCase.scoring_rule_id) {
    throw new Error(`Production corpus ${testCase.id} has an invalid scoring rule reference`);
  }
}

if (productionCorpusManifest.length > 32) {
  throw new Error('Production corpus manifest exceeds its thirty-two-program bound');
}
