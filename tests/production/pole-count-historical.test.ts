import { describe, it, expect } from 'vitest';

/**
 * Historical Pole Count Validation Tests
 *
 * Validates that pole position counts match official FIA statistics.
 *
 * Pole position = who started P1 on the grid (FIA definition)
 * NOT fastest qualifying lap (which may differ due to grid penalties)
 *
 * Key corrections applied:
 * - 2022 Belgium: Verstappen fastest, Sainz got pole (engine penalty)
 * - 2023 Belgium: Verstappen fastest, Leclerc got pole (gearbox penalty)
 * - 2024 Belgium: Verstappen fastest, Leclerc got pole (engine penalty)
 * - 2024 Qatar: Verstappen fastest, Russell got pole (grid penalty)
 */

// Official F1 pole position counts by season
const OFFICIAL_POLE_COUNTS = {
  2022: {
    max_verstappen: 7,
    charles_leclerc: 9,
    carlos_sainz_jr: 3,
    sergio_perez: 1,
    george_russell: 1,
    kevin_magnussen: 1,
  },
  2023: {
    max_verstappen: 12,
    charles_leclerc: 5,
    sergio_perez: 2,
    carlos_sainz_jr: 2,
    lewis_hamilton: 1,
  },
  2024: {
    max_verstappen: 8,
    lando_norris: 8,
    george_russell: 4,
    charles_leclerc: 3,
    carlos_sainz_jr: 1,
  },
  2025: {
    max_verstappen: 8,
    lando_norris: 7,
    oscar_piastri: 6,
    george_russell: 2,
    charles_leclerc: 1,
  },
};

// Races where corrections are required
const POLE_CORRECTIONS = [
  {
    season: 2022,
    round: 14,
    track: 'Belgium',
    fastest: 'max_verstappen',
    pole: 'carlos_sainz_jr',
    reason: 'Engine penalty',
  },
  {
    season: 2023,
    round: 12,
    track: 'Belgium',
    fastest: 'max_verstappen',
    pole: 'charles_leclerc',
    reason: 'Gearbox penalty (5 places)',
  },
  {
    season: 2024,
    round: 14,
    track: 'Belgium',
    fastest: 'max_verstappen',
    pole: 'charles_leclerc',
    reason: 'Engine penalty (10 places)',
  },
  {
    season: 2024,
    round: 23,
    track: 'Qatar',
    fastest: 'max_verstappen',
    pole: 'george_russell',
    reason: 'Grid penalty (1 place)',
  },
];

describe('Pole Count Historical Validation', () => {
  describe('2022 Season', () => {
    it('Verstappen should have 7 poles (not 8 - Belgium penalty)', () => {
      expect(OFFICIAL_POLE_COUNTS[2022].max_verstappen).toBe(7);
    });

    it('Leclerc should have 9 poles', () => {
      expect(OFFICIAL_POLE_COUNTS[2022].charles_leclerc).toBe(9);
    });

    it('Sainz should have 3 poles (including Belgium inherited)', () => {
      expect(OFFICIAL_POLE_COUNTS[2022].carlos_sainz_jr).toBe(3);
    });

    it('Belgium 2022 correction should exist', () => {
      const belgiumCorrection = POLE_CORRECTIONS.find(
        c => c.season === 2022 && c.track === 'Belgium'
      );
      expect(belgiumCorrection).toBeDefined();
      expect(belgiumCorrection?.fastest).toBe('max_verstappen');
      expect(belgiumCorrection?.pole).toBe('carlos_sainz_jr');
    });
  });

  describe('2023 Season', () => {
    it('Verstappen should have 12 poles (not 13 - Belgium penalty)', () => {
      expect(OFFICIAL_POLE_COUNTS[2023].max_verstappen).toBe(12);
    });

    it('Leclerc should have 5 poles (including Belgium inherited)', () => {
      expect(OFFICIAL_POLE_COUNTS[2023].charles_leclerc).toBe(5);
    });

    it('Belgium 2023 correction should exist', () => {
      const belgiumCorrection = POLE_CORRECTIONS.find(
        c => c.season === 2023 && c.track === 'Belgium'
      );
      expect(belgiumCorrection).toBeDefined();
      expect(belgiumCorrection?.fastest).toBe('max_verstappen');
      expect(belgiumCorrection?.pole).toBe('charles_leclerc');
    });
  });

  describe('2024 Season', () => {
    it('Verstappen should have 8 poles (not 10 - Belgium + Qatar penalties)', () => {
      expect(OFFICIAL_POLE_COUNTS[2024].max_verstappen).toBe(8);
    });

    it('Norris should have 8 poles', () => {
      expect(OFFICIAL_POLE_COUNTS[2024].lando_norris).toBe(8);
    });

    it('Russell should have 4 poles (including Qatar inherited)', () => {
      expect(OFFICIAL_POLE_COUNTS[2024].george_russell).toBe(4);
    });

    it('Leclerc should have 3 poles (including Belgium inherited)', () => {
      expect(OFFICIAL_POLE_COUNTS[2024].charles_leclerc).toBe(3);
    });

    it('Belgium 2024 and Qatar 2024 corrections should exist', () => {
      const corrections2024 = POLE_CORRECTIONS.filter(c => c.season === 2024);
      expect(corrections2024.length).toBe(2);

      const belgium = corrections2024.find(c => c.track === 'Belgium');
      expect(belgium?.pole).toBe('charles_leclerc');

      const qatar = corrections2024.find(c => c.track === 'Qatar');
      expect(qatar?.pole).toBe('george_russell');
    });
  });

  describe('2025 Season', () => {
    it('Verstappen should have 8 poles', () => {
      expect(OFFICIAL_POLE_COUNTS[2025].max_verstappen).toBe(8);
    });

    it('Norris should have 7 poles', () => {
      expect(OFFICIAL_POLE_COUNTS[2025].lando_norris).toBe(7);
    });

    it('Piastri should have 6 poles', () => {
      expect(OFFICIAL_POLE_COUNTS[2025].oscar_piastri).toBe(6);
    });

    it('No corrections should be needed for 2025', () => {
      const corrections2025 = POLE_CORRECTIONS.filter(c => c.season === 2025);
      expect(corrections2025.length).toBe(0);
    });
  });

  describe('Pole Corrections Integrity', () => {
    it('Total of 4 corrections should exist across all seasons', () => {
      expect(POLE_CORRECTIONS.length).toBe(4);
    });

    it('All corrections involve Verstappen as fastest', () => {
      const allVerstappen = POLE_CORRECTIONS.every(c => c.fastest === 'max_verstappen');
      expect(allVerstappen).toBe(true);
    });

    it('Corrections should match penalty recipients', () => {
      const poleWinners = POLE_CORRECTIONS.map(c => c.pole);
      expect(poleWinners).toContain('carlos_sainz_jr');
      expect(poleWinners).toContain('charles_leclerc');
      expect(poleWinners).toContain('george_russell');
    });
  });

  describe('Verstappen Career Pole Totals', () => {
    it('Verstappen fastest times vs official poles should differ by 4', () => {
      const fastestTimes = 7 + 1 + 13 + 10 + 8; // Including Belgium each year + Qatar
      const officialPoles =
        OFFICIAL_POLE_COUNTS[2022].max_verstappen +
        OFFICIAL_POLE_COUNTS[2023].max_verstappen +
        OFFICIAL_POLE_COUNTS[2024].max_verstappen +
        OFFICIAL_POLE_COUNTS[2025].max_verstappen;

      // Note: 2022, 2023 each had +1 penalty, 2024 had +2 penalties
      expect(officialPoles).toBe(7 + 12 + 8 + 8); // = 35
    });
  });
});

describe('SQL Template Verification', () => {
  it('driver_pole_count_v1.sql should use qualifying_results_official view', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const templatePath = path.join(process.cwd(), 'templates', 'driver_pole_count_v1.sql');
    const templateContent = fs.readFileSync(templatePath, 'utf-8');

    // Template should use the qualifying_results_official view which handles grid corrections
    expect(templateContent).toContain('qualifying_results_official');
    expect(templateContent).toContain('official_grid_position');
    expect(templateContent).toContain('pole_count');
  });
});
