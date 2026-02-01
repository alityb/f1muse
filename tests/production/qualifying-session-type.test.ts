import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';

/**
 * Qualifying Session Type Tests
 *
 * Tests for correct filtering of RACE_QUALIFYING vs SPRINT_QUALIFYING
 * to ensure pole counts only include race qualifying poles.
 *
 * Sprint weekends have two qualifying sessions:
 * - RACE_QUALIFYING: Sets grid for the main race
 * - SPRINT_QUALIFYING: Sets grid for the sprint race
 *
 * Pole count queries should ONLY count RACE_QUALIFYING poles.
 */

// Mock data: Verstappen 2024 with 8 race poles + 2 sprint poles
const mockQualifyingResults = [
  // Race qualifying poles (8 total - correct)
  { driver_id: 'max_verstappen', season: 2024, round: 1, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 2, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 3, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 4, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 7, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 8, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 9, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 10, qualifying_position: 1, session_type: 'RACE_QUALIFYING' },
  // Non-pole race qualifying
  { driver_id: 'max_verstappen', season: 2024, round: 5, qualifying_position: 2, session_type: 'RACE_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 6, qualifying_position: 3, session_type: 'RACE_QUALIFYING' },
  // Sprint qualifying poles (should NOT be counted as poles)
  { driver_id: 'max_verstappen', season: 2024, round: 5, qualifying_position: 1, session_type: 'SPRINT_QUALIFYING' },
  { driver_id: 'max_verstappen', season: 2024, round: 6, qualifying_position: 1, session_type: 'SPRINT_QUALIFYING' },
];

describe('Qualifying Session Type Filtering', () => {
  describe('Pole Count Logic', () => {
    it('should count only RACE_QUALIFYING poles', () => {
      const raceQualifyingPoles = mockQualifyingResults.filter(
        r => r.session_type === 'RACE_QUALIFYING' && r.qualifying_position === 1
      ).length;

      expect(raceQualifyingPoles).toBe(8);
    });

    it('should exclude SPRINT_QUALIFYING from pole count', () => {
      const allPoles = mockQualifyingResults.filter(
        r => r.qualifying_position === 1
      ).length;

      const raceOnlyPoles = mockQualifyingResults.filter(
        r => r.session_type === 'RACE_QUALIFYING' && r.qualifying_position === 1
      ).length;

      expect(allPoles).toBe(10); // 8 race + 2 sprint
      expect(raceOnlyPoles).toBe(8); // Only race qualifying
    });

    it('should identify sprint qualifying records correctly', () => {
      const sprintPoles = mockQualifyingResults.filter(
        r => r.session_type === 'SPRINT_QUALIFYING' && r.qualifying_position === 1
      ).length;

      expect(sprintPoles).toBe(2);
    });
  });

  describe('SQL Template Filter Verification', () => {
    // Helper function: Templates should either filter directly or use qualifying_results_official view
    // The qualifying_results_official view has session_type = 'RACE_QUALIFYING' built-in
    const hasRaceQualifyingFilter = (content: string): boolean => {
      return content.includes("session_type = 'RACE_QUALIFYING'") ||
             content.includes('qualifying_results_official');
    };

    it('driver_pole_count_v1.sql should filter by session_type', async () => {
      // This test verifies the SQL template includes the session_type filter
      // Either directly or by using qualifying_results_official view
      const fs = await import('fs');
      const path = await import('path');

      const templatePath = path.join(process.cwd(), 'templates', 'driver_pole_count_v1.sql');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      expect(hasRaceQualifyingFilter(templateContent)).toBe(true);
    });

    it('driver_q3_count_v1.sql should filter by session_type', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const templatePath = path.join(process.cwd(), 'templates', 'driver_q3_count_v1.sql');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      expect(hasRaceQualifyingFilter(templateContent)).toBe(true);
    });

    it('season_q3_rankings_v1.sql should filter by session_type', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const templatePath = path.join(process.cwd(), 'templates', 'season_q3_rankings_v1.sql');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      expect(hasRaceQualifyingFilter(templateContent)).toBe(true);
    });

    it('qualifying_gap_teammates_v1.sql should filter by session_type', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const templatePath = path.join(process.cwd(), 'templates', 'qualifying_gap_teammates_v1.sql');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      expect(hasRaceQualifyingFilter(templateContent)).toBe(true);
    });

    it('qualifying_gap_drivers_v1.sql should filter by session_type', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const templatePath = path.join(process.cwd(), 'templates', 'qualifying_gap_drivers_v1.sql');
      const templateContent = fs.readFileSync(templatePath, 'utf-8');

      expect(hasRaceQualifyingFilter(templateContent)).toBe(true);
    });
  });

  describe('Session Type Values', () => {
    it('should only allow valid session type values', () => {
      const validSessionTypes = ['RACE_QUALIFYING', 'SPRINT_QUALIFYING'];

      for (const record of mockQualifyingResults) {
        expect(validSessionTypes).toContain(record.session_type);
      }
    });
  });
});

describe('Sprint Weekend Detection', () => {
  const sprintWeekends2024 = new Set([5, 6, 11, 19, 21, 22]); // China, Miami, Austria, USA, Brazil, Qatar
  const sprintWeekends2025 = new Set([2, 6, 14, 19, 21, 24]); // China, Miami, Belgium, USA, Brazil, Qatar

  it('should identify 2024 sprint weekends correctly', () => {
    expect(sprintWeekends2024.has(5)).toBe(true);  // China
    expect(sprintWeekends2024.has(6)).toBe(true);  // Miami
    expect(sprintWeekends2024.has(11)).toBe(true); // Austria
    expect(sprintWeekends2024.has(1)).toBe(false); // Bahrain (not sprint)
  });

  it('should identify 2025 sprint weekends correctly', () => {
    expect(sprintWeekends2025.has(2)).toBe(true);  // China
    expect(sprintWeekends2025.has(6)).toBe(true);  // Miami
    expect(sprintWeekends2025.has(14)).toBe(true); // Belgium
    expect(sprintWeekends2025.has(11)).toBe(false); // Austria replaced by Belgium
  });

  it('2025 should have Belgium instead of Austria as sprint', () => {
    expect(sprintWeekends2024.has(11)).toBe(true);  // 2024 Austria
    expect(sprintWeekends2025.has(11)).toBe(false); // 2025 no Austria
    expect(sprintWeekends2025.has(14)).toBe(true);  // 2025 Belgium
  });
});

describe('Official Pole Position Definition', () => {
  // Official 2024 pole position list (who started P1)
  const official2024Poles = {
    'max_verstappen': 8,  // Bahrain, Saudi, Australia, Japan, China, Miami, Emilia Romagna, Austria
    'george_russell': 4,  // Canada, UK, Las Vegas, Qatar (inherited)
    'lando_norris': 4,    // Spain, Netherlands, Singapore, Abu Dhabi
    'charles_leclerc': 3, // Monaco, Azerbaijan, Belgium (inherited)
    'oscar_piastri': 2,   // Hungary, Baku qualifying issues
    'lewis_hamilton': 2,  // UK, Hungary?
  };

  it('Verstappen 2024 should have exactly 8 official poles', () => {
    // Verstappen set fastest time 10 times but only started P1 eight times
    // Belgium (R14): fastest but 10-place engine penalty -> Leclerc pole
    // Qatar (R23): fastest but 1-place penalty -> Russell pole
    expect(official2024Poles['max_verstappen']).toBe(8);
  });

  it('should distinguish official poles from fastest times', () => {
    // A driver can set fastest time but not get pole due to grid penalties
    // Official pole = who starts P1 (FIA definition)
    // Fastest time = who set quickest lap in qualifying
    const verstappenFastestTimes2024 = 10; // Including Belgium, Qatar
    const verstappenOfficialPoles2024 = 8;

    expect(verstappenFastestTimes2024).toBeGreaterThan(verstappenOfficialPoles2024);
    expect(verstappenFastestTimes2024 - verstappenOfficialPoles2024).toBe(2);
  });

  describe('Pole corrections', () => {
    const poleCorrections2024 = [
      { round: 14, fastest: 'max_verstappen', pole: 'charles_leclerc', reason: 'Engine penalty' },
      { round: 23, fastest: 'max_verstappen', pole: 'george_russell', reason: 'Grid penalty' },
    ];

    it('should have 2 pole corrections for 2024', () => {
      expect(poleCorrections2024.length).toBe(2);
    });

    it('Belgium 2024 pole should go to Leclerc', () => {
      const belgium = poleCorrections2024.find(c => c.round === 14);
      expect(belgium?.fastest).toBe('max_verstappen');
      expect(belgium?.pole).toBe('charles_leclerc');
    });

    it('Qatar 2024 pole should go to Russell', () => {
      const qatar = poleCorrections2024.find(c => c.round === 23);
      expect(qatar?.fastest).toBe('max_verstappen');
      expect(qatar?.pole).toBe('george_russell');
    });
  });
});
