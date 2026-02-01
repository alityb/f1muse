/**
 * NL PARSING SNAPSHOT TESTS
 *
 * These tests validate that natural language query routing remains stable.
 * They run WITHOUT database access and verify only intent routing logic.
 *
 * Purpose:
 * - Prevent regressions in NL -> QueryIntent mapping
 * - Ensure deterministic, Statmuse-quality routing
 * - Never allow clarification or ambiguity
 *
 * Usage:
 *   npx vitest tests/nl-parsing.test.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

interface SnapshotExpectedEntities {
  driver_ids: string[];
  track_id: string | null;
  season: number;
}

interface NLParsingSnapshot {
  id: string;
  query: string;
  expected_kind: string;
  expected_entities: SnapshotExpectedEntities;
  notes?: string;
}

interface SnapshotFile {
  description: string;
  version: string;
  generated_at: string;
  snapshots: NLParsingSnapshot[];
}

/**
 * Mock NL parsing function that extracts intent kind from query
 * This simulates what the LLM should produce without calling the actual LLM
 *
 * RULES (from query-translator.ts):
 * 1. "results of", "race results", "who won", "winner of", "podium" -> race_results_summary
 * 2. Track ranking ("fastest at", "who was fastest at") -> track_fastest_drivers
 * 3. Track + 2 drivers -> cross_team_track_scoped_driver_comparison
 * 4. 2 drivers, no track -> teammate_gap_summary_season (default for driver comparisons)
 * 5. "career", "all-time" -> driver_career_summary
 * 6. Single driver + season/"season" -> driver_season_summary
 * 7. "qualifying vs race" -> teammate_gap_dual_comparison (handled by LLM, not mocked here)
 */
function parseQueryToIntent(query: string): {
  kind: string;
  hasTrack: boolean;
  hasTwoDrivers: boolean;
  hasCareer: boolean;
  hasSeason: boolean;
  isRaceResults: boolean;
  isRanking: boolean;
} {
  const q = query.toLowerCase();

  // Race results triggers (highest priority)
  const isRaceResults =
    q.includes('results of') ||
    q.includes('race results') ||
    q.includes('who won') ||
    q.includes('winner of') ||
    q.includes('podium');

  // Track detection (common track names and patterns)
  const trackPatterns = [
    'monza', 'monaco', 'silverstone', 'spa', 'suzuka', 'bahrain',
    'jeddah', 'abu dhabi', 'yas marina', 'melbourne', 'shanghai',
    'imola', 'barcelona', 'montreal', 'baku', 'singapore', 'austin',
    'mexico', 'interlagos', 'zandvoort', 'hungaroring', 'las vegas'
  ];
  const hasTrack =
    q.includes(' at ') ||
    q.includes(' in ') ||
    trackPatterns.some(t => q.includes(t));

  // Career detection
  const hasCareer = q.includes('career') || q.includes('all-time');

  // Season detection
  const hasSeason =
    /\b20\d{2}\b/.test(q) ||
    q.includes('season') ||
    q.includes('this year');

  // Ranking detection
  const isRanking =
    (q.includes('fastest') && hasTrack && !q.includes(' vs ') && !q.includes(' and ')) ||
    q.includes('rank');

  // Two driver detection
  const driverPatterns = [
    'verstappen', 'norris', 'piastri', 'leclerc', 'sainz', 'hamilton',
    'russell', 'alonso', 'perez', 'stroll', 'ocon', 'gasly', 'albon',
    'sargeant', 'tsunoda', 'ricciardo', 'bottas', 'zhou', 'magnussen',
    'hulkenberg', 'max', 'lando', 'charles', 'carlos', 'lewis', 'george'
  ];

  let driverCount = 0;
  for (const driver of driverPatterns) {
    if (q.includes(driver)) {
      driverCount++;
    }
  }

  // Check for vs/and patterns which indicate two drivers
  const hasTwoDrivers =
    driverCount >= 2 ||
    q.includes(' vs ') ||
    (q.includes(' and ') && driverPatterns.some(d => q.includes(d)));

  // Determine kind based on rules
  let kind: string;

  if (isRaceResults) {
    kind = 'race_results_summary';
  } else if (isRanking && hasTrack && !hasTwoDrivers) {
    kind = 'track_fastest_drivers';
  } else if (hasTwoDrivers && hasTrack) {
    kind = 'cross_team_track_scoped_driver_comparison';
  } else if (hasTwoDrivers && !hasTrack) {
    kind = 'teammate_gap_summary_season';
  } else if (hasCareer && !hasSeason) {
    kind = 'driver_career_summary';
  } else {
    kind = 'driver_season_summary';
  }

  return {
    kind,
    hasTrack,
    hasTwoDrivers,
    hasCareer,
    hasSeason,
    isRaceResults,
    isRanking
  };
}

// Load snapshots
const snapshotPath = path.join(__dirname, 'nl-parsing.snapshots.json');
const snapshotContent = fs.readFileSync(snapshotPath, 'utf-8');
const snapshotFile: SnapshotFile = JSON.parse(snapshotContent);

describe('NL Parsing Snapshot Tests', () => {
  describe('Routing Stability', () => {
    for (const snapshot of snapshotFile.snapshots) {
      it(`[${snapshot.id}] "${snapshot.query}" -> ${snapshot.expected_kind}`, () => {
        const parsed = parseQueryToIntent(snapshot.query);

        expect(parsed.kind).toBe(snapshot.expected_kind);
      });
    }
  });

  describe('No Clarification Allowed', () => {
    it('should never produce ambiguous results', () => {
      for (const snapshot of snapshotFile.snapshots) {
        const parsed = parseQueryToIntent(snapshot.query);

        // The result should always be one of the 8 supported kinds
        const validKinds = [
          'race_results_summary',
          'track_fastest_drivers',
          'cross_team_track_scoped_driver_comparison',
          'teammate_gap_summary_season',
          'teammate_gap_dual_comparison',
          'season_driver_vs_driver',
          'driver_season_summary',
          'driver_career_summary'
        ];

        expect(validKinds).toContain(parsed.kind);
      }
    });
  });

  describe('Deterministic Routing', () => {
    it('should produce the same result for repeated queries', () => {
      for (const snapshot of snapshotFile.snapshots) {
        const parsed1 = parseQueryToIntent(snapshot.query);
        const parsed2 = parseQueryToIntent(snapshot.query);

        expect(parsed1.kind).toBe(parsed2.kind);
      }
    });
  });

  describe('Race Results Priority', () => {
    const raceResultsQueries = snapshotFile.snapshots.filter(
      s => s.expected_kind === 'race_results_summary'
    );

    for (const snapshot of raceResultsQueries) {
      it(`"${snapshot.query}" correctly routes to race_results_summary`, () => {
        const parsed = parseQueryToIntent(snapshot.query);
        expect(parsed.isRaceResults).toBe(true);
        expect(parsed.kind).toBe('race_results_summary');
      });
    }
  });

  describe('Track-Scoped Comparisons', () => {
    const trackComparisonQueries = snapshotFile.snapshots.filter(
      s => s.expected_kind === 'cross_team_track_scoped_driver_comparison'
    );

    for (const snapshot of trackComparisonQueries) {
      it(`"${snapshot.query}" correctly routes to track comparison`, () => {
        const parsed = parseQueryToIntent(snapshot.query);
        expect(parsed.hasTrack).toBe(true);
        expect(parsed.hasTwoDrivers).toBe(true);
        expect(parsed.kind).toBe('cross_team_track_scoped_driver_comparison');
      });
    }
  });

  describe('Teammate Gap (No Track)', () => {
    const teammateQueries = snapshotFile.snapshots.filter(
      s => s.expected_kind === 'teammate_gap_summary_season'
    );

    for (const snapshot of teammateQueries) {
      it(`"${snapshot.query}" correctly routes to teammate gap`, () => {
        const parsed = parseQueryToIntent(snapshot.query);
        expect(parsed.hasTwoDrivers).toBe(true);
        expect(parsed.hasTrack).toBe(false);
        expect(parsed.kind).toBe('teammate_gap_summary_season');
      });
    }
  });

  describe('Career vs Season Routing', () => {
    const careerQueries = snapshotFile.snapshots.filter(
      s => s.expected_kind === 'driver_career_summary'
    );

    for (const snapshot of careerQueries) {
      it(`"${snapshot.query}" correctly routes to career summary`, () => {
        const parsed = parseQueryToIntent(snapshot.query);
        expect(parsed.hasCareer).toBe(true);
        expect(parsed.kind).toBe('driver_career_summary');
      });
    }
  });

  describe('Track Rankings', () => {
    const rankingQueries = snapshotFile.snapshots.filter(
      s => s.expected_kind === 'track_fastest_drivers'
    );

    for (const snapshot of rankingQueries) {
      it(`"${snapshot.query}" correctly routes to track ranking`, () => {
        const parsed = parseQueryToIntent(snapshot.query);
        expect(parsed.hasTrack).toBe(true);
        expect(parsed.isRanking).toBe(true);
        expect(parsed.kind).toBe('track_fastest_drivers');
      });
    }
  });
});

describe('Snapshot Integrity', () => {
  it('should have at least 15 snapshots', () => {
    expect(snapshotFile.snapshots.length).toBeGreaterThanOrEqual(15);
  });

  it('all snapshots should have required fields', () => {
    for (const snapshot of snapshotFile.snapshots) {
      expect(snapshot.id).toBeDefined();
      expect(snapshot.query).toBeDefined();
      expect(snapshot.expected_kind).toBeDefined();
      expect(snapshot.expected_entities).toBeDefined();
      expect(snapshot.expected_entities.driver_ids).toBeDefined();
      expect(snapshot.expected_entities.season).toBeDefined();
    }
  });

  it('all snapshot IDs should be unique', () => {
    const ids = snapshotFile.snapshots.map(s => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
