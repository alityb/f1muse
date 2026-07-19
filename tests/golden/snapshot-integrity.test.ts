import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { goldenRegistry } from './golden-registry';

interface JolpicaDriverStanding {
  points: string;
  wins: string;
  Driver: { driverId: string };
}

interface JolpicaSnapshot {
  source_url: string;
  payload: {
    MRData?: {
      StandingsTable?: {
        StandingsLists?: Array<{ DriverStandings?: JolpicaDriverStanding[] }>;
      };
    };
  };
}

function driverIdForGolden(subject: string): string {
  if (subject === 'lewis-hamilton') return 'hamilton';
  if (subject === 'george-russell') return 'russell';
  return subject.replace(/-/g, '_');
}

describe('verified golden snapshot integrity', () => {
  for (const golden of goldenRegistry.cases.filter((caseDefinition) => caseDefinition.status === 'verified')) {
    it(`${golden.id} matches its source snapshot`, () => {
      const snapshotPath = resolve(process.cwd(), golden.evidence.snapshot!);
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as JolpicaSnapshot;
      expect(snapshot.source_url).toBe(golden.evidence.reference);

      const standings = snapshot.payload.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
      for (const assertion of golden.assertions) {
        const standing = standings.find(
          (candidate) => candidate.Driver.driverId === driverIdForGolden(assertion.subject)
        );

        if (assertion.metric === 'season_participation' && assertion.equals === false) {
          expect(standing).toBeUndefined();
          continue;
        }

        expect(standing).toBeDefined();
        if (assertion.metric === 'championship_points') {
          expect(Number(standing!.points)).toBe(assertion.equals);
        }
        if (assertion.metric === 'wins') {
          expect(Number(standing!.wins)).toBe(assertion.equals);
        }
      }
    });
  }
});
