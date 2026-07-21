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
    publisher: 'FIA';
    document: string;
    url: string;
  };
  scoring_rule_id?: string;
  expected_facts?: Array<Record<string, unknown>>;
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
    program: { version: 1, root: { op: 'aggregate', input: { op: 'filter', input: { op: 'source', source: 'standings' }, where: { season: 2025 } }, group_by: ['driver_id'], measures: [{ as: 'points', function: 'sum', field: 'points' }] } }
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
  }
];

for (const testCase of productionCorpusManifest) {
  if (!testCase.scoring_rule_id || testCase.program.root.op !== 'event_classification') {
    continue;
  }
  const resolution = resolveChampionshipScoringRules(testCase.program.root.season);
  if (resolution.status !== 'supported' || resolution.rules.id !== testCase.scoring_rule_id) {
    throw new Error(`Production corpus ${testCase.id} has an invalid scoring rule reference`);
  }
}

if (productionCorpusManifest.length > 6) {
  throw new Error('Production corpus manifest exceeds its six-program bound');
}
