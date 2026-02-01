/**
 * Deterministic Integration Test Fixtures
 *
 * Minimal dataset that provides coverage for all query types:
 * - 2 seasons (2024, 2025)
 * - 6+ drivers
 * - 3 teams
 * - 3 tracks
 * - Teammate relationships
 * - Race results with qualifying and race positions
 */

export interface DriverFixture {
  id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  abbreviation: string;
}

export interface CircuitFixture {
  id: string;
  name: string;
  full_name: string;
}

export interface GrandPrixFixture {
  id: string;
  name: string;
  full_name: string;
  short_name: string;
  abbreviation: string;
}

export interface RaceFixture {
  id: number;
  year: number;
  round: number;
}

export interface RaceDataFixture {
  race_id: number;
  type: 'race' | 'qualifying';
  driver_id: string;
  constructor_id: string | null;
  position_number: number | null;
  race_reason_retired: string | null;
}

export interface SeasonEntrantDriverFixture {
  year: number;
  entrant_id: string;
  constructor_id: string;
  driver_id: string;
  test_driver: boolean;
}

export interface PaceMetricSeasonFixture {
  driver_id: string;
  season: number;
  metric_name: string;
  metric_value: number;
  normalization: string;
  laps_considered: number;
  clean_air_only: boolean;
  compound_context: string;
  session_scope: string;
}

export interface PaceMetricTrackFixture {
  driver_id: string;
  season: number;
  track_id: string;
  metric_name: string;
  metric_value: number;
  normalization: string;
  laps_considered: number;
  clean_air_only: boolean;
  compound_context: string;
  session_scope: string;
}

export interface TeammateGapSummaryFixture {
  season: number;
  team_id: string;
  driver_primary_id: string;
  driver_secondary_id: string;
  driver_pair_gap_percent: number;
  driver_pair_gap_seconds: number;
  gap_percent: number;
  shared_races: number;
  faster_driver_primary_count: number;
  coverage_status: string;
  failure_reason: string | null;
}

export interface LapNormalizedFixture {
  season: number;
  round: number;
  track_id: string;
  driver_id: string;
  lap_number: number;
  lap_time_seconds: number;
  is_valid_lap: boolean;
  is_pit_lap: boolean;
  clean_air_flag: boolean;
  is_out_lap?: boolean;
  is_in_lap?: boolean;
}

export interface MatchupMatrixFixture {
  driver_a_id: string;
  driver_b_id: string;
  metric: string;
  season: number;
  driver_a_wins: number;
  driver_b_wins: number;
  ties: number;
  shared_events: number;
  coverage_status: string;
}

/**
 * DETERMINISTIC FIXTURES
 *
 * All values are chosen to produce predictable, verifiable results.
 */
export const FIXTURES = {
  seasons: [2024, 2025],

  drivers: [
    { id: 'max_verstappen', full_name: 'Max Verstappen', first_name: 'Max', last_name: 'Verstappen', abbreviation: 'VER' },
    { id: 'sergio_perez', full_name: 'Sergio Perez', first_name: 'Sergio', last_name: 'Perez', abbreviation: 'PER' },
    { id: 'charles_leclerc', full_name: 'Charles Leclerc', first_name: 'Charles', last_name: 'Leclerc', abbreviation: 'LEC' },
    { id: 'carlos_sainz', full_name: 'Carlos Sainz', first_name: 'Carlos', last_name: 'Sainz', abbreviation: 'SAI' },
    { id: 'lando_norris', full_name: 'Lando Norris', first_name: 'Lando', last_name: 'Norris', abbreviation: 'NOR' },
    { id: 'oscar_piastri', full_name: 'Oscar Piastri', first_name: 'Oscar', last_name: 'Piastri', abbreviation: 'PIA' },
    { id: 'lewis_hamilton', full_name: 'Lewis Hamilton', first_name: 'Lewis', last_name: 'Hamilton', abbreviation: 'HAM' },
    { id: 'george_russell', full_name: 'George Russell', first_name: 'George', last_name: 'Russell', abbreviation: 'RUS' }
  ] as DriverFixture[],

  circuits: [
    { id: 'bahrain', name: 'Bahrain', full_name: 'Bahrain International Circuit' },
    { id: 'jeddah', name: 'Jeddah', full_name: 'Jeddah Corniche Circuit' },
    { id: 'silverstone', name: 'Silverstone', full_name: 'Silverstone Circuit' }
  ] as CircuitFixture[],

  grandPrix: [
    { id: 'bahrain_gp', name: 'Bahrain Grand Prix', full_name: 'Formula 1 Bahrain Grand Prix', short_name: 'Bahrain GP', abbreviation: 'BHR' },
    { id: 'saudi_gp', name: 'Saudi Arabian Grand Prix', full_name: 'Formula 1 Saudi Arabian Grand Prix', short_name: 'Saudi GP', abbreviation: 'SAU' },
    { id: 'british_gp', name: 'British Grand Prix', full_name: 'Formula 1 British Grand Prix', short_name: 'British GP', abbreviation: 'GBR' }
  ] as GrandPrixFixture[],

  // 2025 season: 10 races (rounds 1-10)
  // 2024 season: 10 races (rounds 1-10)
  races: [
    // 2025 races
    { id: 2025001, year: 2025, round: 1 },
    { id: 2025002, year: 2025, round: 2 },
    { id: 2025003, year: 2025, round: 3 },
    { id: 2025004, year: 2025, round: 4 },
    { id: 2025005, year: 2025, round: 5 },
    { id: 2025006, year: 2025, round: 6 },
    { id: 2025007, year: 2025, round: 7 },
    { id: 2025008, year: 2025, round: 8 },
    { id: 2025009, year: 2025, round: 9 },
    { id: 2025010, year: 2025, round: 10 },
    // 2024 races
    { id: 2024001, year: 2024, round: 1 },
    { id: 2024002, year: 2024, round: 2 },
    { id: 2024003, year: 2024, round: 3 },
    { id: 2024004, year: 2024, round: 4 },
    { id: 2024005, year: 2024, round: 5 },
    { id: 2024006, year: 2024, round: 6 },
    { id: 2024007, year: 2024, round: 7 },
    { id: 2024008, year: 2024, round: 8 },
    { id: 2024009, year: 2024, round: 9 },
    { id: 2024010, year: 2024, round: 10 }
  ] as RaceFixture[],

  // Race data: qualifying and race positions
  // Deterministic pattern: VER beats PER 7-3, NOR beats PIA 6-4, LEC beats SAI 5-5
  raceData: [
    // 2025 Round 1 - VER P1, PER P3, NOR P2, PIA P4, LEC P5, SAI P6
    { race_id: 2025001, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025001, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025001, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025001, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025001, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025001, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025001, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    // 2025 Round 2 - VER P1, PER P4, NOR P2, PIA P3, LEC P6, SAI P5
    { race_id: 2025002, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025002, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025002, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025002, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025002, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025002, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025002, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    // 2025 Rounds 3-10: Similar pattern ensuring VER 7-3 PER, NOR 6-4 PIA, LEC 5-5 SAI
    // Round 3: VER beats PER, NOR beats PIA, LEC beats SAI
    { race_id: 2025003, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025003, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 5, race_reason_retired: null },
    { race_id: 2025003, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025003, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025003, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025003, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 5, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025003, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    // Round 4: VER beats PER, NOR beats PIA, SAI beats LEC
    { race_id: 2025004, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025004, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025004, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025004, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025004, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025004, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025004, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    // Round 5: VER beats PER, NOR beats PIA, LEC beats SAI
    { race_id: 2025005, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025005, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025005, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025005, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025005, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025005, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025005, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    // Round 6: VER beats PER, PIA beats NOR, SAI beats LEC
    { race_id: 2025006, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025006, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025006, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025006, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025006, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025006, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025006, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    // Round 7: VER beats PER, NOR beats PIA, LEC beats SAI
    { race_id: 2025007, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025007, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 5, race_reason_retired: null },
    { race_id: 2025007, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025007, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025007, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025007, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 5, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025007, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    // Round 8: PER beats VER (1 of 3), PIA beats NOR (2 of 4), SAI beats LEC
    { race_id: 2025008, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 2, race_reason_retired: null },
    { race_id: 2025008, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025008, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025008, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025008, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025008, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 2, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 4, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 3, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025008, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 5, race_reason_retired: null },
    // Round 9: PER beats VER (2 of 3), PIA beats NOR (3 of 4), LEC beats SAI
    { race_id: 2025009, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025009, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 2, race_reason_retired: null },
    { race_id: 2025009, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025009, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 1, race_reason_retired: null },
    { race_id: 2025009, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 4, race_reason_retired: null },
    { race_id: 2025009, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 3, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 2, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 1, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 4, race_reason_retired: null },
    { race_id: 2025009, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    // Round 10: PER beats VER (3 of 3), PIA beats NOR (4 of 4), SAI beats LEC
    { race_id: 2025010, type: 'qualifying', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025010, type: 'qualifying', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025010, type: 'qualifying', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025010, type: 'qualifying', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025010, type: 'qualifying', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025010, type: 'qualifying', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 3, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'max_verstappen', constructor_id: 'RBR', position_number: 4, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'sergio_perez', constructor_id: 'RBR', position_number: 1, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'lando_norris', constructor_id: 'MCL', position_number: 5, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'oscar_piastri', constructor_id: 'MCL', position_number: 2, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'charles_leclerc', constructor_id: 'FER', position_number: 6, race_reason_retired: null },
    { race_id: 2025010, type: 'race', driver_id: 'carlos_sainz', constructor_id: 'FER', position_number: 3, race_reason_retired: null }
  ] as RaceDataFixture[],

  // Team assignments
  seasonEntrantDrivers: [
    // 2025 season
    { year: 2025, entrant_id: 'red_bull', constructor_id: 'RBR', driver_id: 'max_verstappen', test_driver: false },
    { year: 2025, entrant_id: 'red_bull', constructor_id: 'RBR', driver_id: 'sergio_perez', test_driver: false },
    { year: 2025, entrant_id: 'ferrari', constructor_id: 'FER', driver_id: 'charles_leclerc', test_driver: false },
    { year: 2025, entrant_id: 'ferrari', constructor_id: 'FER', driver_id: 'carlos_sainz', test_driver: false },
    { year: 2025, entrant_id: 'mclaren', constructor_id: 'MCL', driver_id: 'lando_norris', test_driver: false },
    { year: 2025, entrant_id: 'mclaren', constructor_id: 'MCL', driver_id: 'oscar_piastri', test_driver: false },
    // 2024 season
    { year: 2024, entrant_id: 'red_bull', constructor_id: 'RBR', driver_id: 'max_verstappen', test_driver: false },
    { year: 2024, entrant_id: 'red_bull', constructor_id: 'RBR', driver_id: 'sergio_perez', test_driver: false },
    { year: 2024, entrant_id: 'ferrari', constructor_id: 'FER', driver_id: 'charles_leclerc', test_driver: false },
    { year: 2024, entrant_id: 'ferrari', constructor_id: 'FER', driver_id: 'carlos_sainz', test_driver: false },
    { year: 2024, entrant_id: 'mclaren', constructor_id: 'MCL', driver_id: 'lando_norris', test_driver: false },
    { year: 2024, entrant_id: 'mclaren', constructor_id: 'MCL', driver_id: 'oscar_piastri', test_driver: false }
  ] as SeasonEntrantDriverFixture[],

  // Pace metrics (season-level) - deterministic values
  paceMetricsSeason: [
    { driver_id: 'max_verstappen', season: 2025, metric_name: 'avg_true_pace', metric_value: 90.5, normalization: 'none', laps_considered: 500, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'sergio_perez', season: 2025, metric_name: 'avg_true_pace', metric_value: 91.2, normalization: 'none', laps_considered: 480, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'charles_leclerc', season: 2025, metric_name: 'avg_true_pace', metric_value: 90.8, normalization: 'none', laps_considered: 490, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'carlos_sainz', season: 2025, metric_name: 'avg_true_pace', metric_value: 91.0, normalization: 'none', laps_considered: 485, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'lando_norris', season: 2025, metric_name: 'avg_true_pace', metric_value: 90.6, normalization: 'none', laps_considered: 495, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'oscar_piastri', season: 2025, metric_name: 'avg_true_pace', metric_value: 90.9, normalization: 'none', laps_considered: 475, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    // Qualifying pace
    { driver_id: 'max_verstappen', season: 2025, metric_name: 'qualifying_pace', metric_value: 88.1, normalization: 'none', laps_considered: 30, clean_air_only: false, compound_context: 'mixed', session_scope: 'qualifying' },
    { driver_id: 'lando_norris', season: 2025, metric_name: 'qualifying_pace', metric_value: 88.3, normalization: 'none', laps_considered: 30, clean_air_only: false, compound_context: 'mixed', session_scope: 'qualifying' },
    { driver_id: 'charles_leclerc', season: 2025, metric_name: 'qualifying_pace', metric_value: 88.4, normalization: 'none', laps_considered: 30, clean_air_only: false, compound_context: 'mixed', session_scope: 'qualifying' },
    // Consistency metric
    { driver_id: 'max_verstappen', season: 2025, metric_name: 'consistency', metric_value: 0.85, normalization: 'none', laps_considered: 500, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'lando_norris', season: 2025, metric_name: 'consistency', metric_value: 0.82, normalization: 'none', laps_considered: 495, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'charles_leclerc', season: 2025, metric_name: 'consistency', metric_value: 0.80, normalization: 'none', laps_considered: 490, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' }
  ] as PaceMetricSeasonFixture[],

  // Pace metrics (track-level) - deterministic values
  paceMetricsTrack: [
    { driver_id: 'max_verstappen', season: 2025, track_id: 'bahrain', metric_name: 'avg_true_pace', metric_value: 90.0, normalization: 'none', laps_considered: 50, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'lando_norris', season: 2025, track_id: 'bahrain', metric_name: 'avg_true_pace', metric_value: 90.3, normalization: 'none', laps_considered: 50, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'charles_leclerc', season: 2025, track_id: 'bahrain', metric_name: 'avg_true_pace', metric_value: 90.5, normalization: 'none', laps_considered: 50, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'max_verstappen', season: 2025, track_id: 'silverstone', metric_name: 'avg_true_pace', metric_value: 88.5, normalization: 'none', laps_considered: 52, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' },
    { driver_id: 'lando_norris', season: 2025, track_id: 'silverstone', metric_name: 'avg_true_pace', metric_value: 88.2, normalization: 'none', laps_considered: 52, clean_air_only: false, compound_context: 'mixed', session_scope: 'race' }
  ] as PaceMetricTrackFixture[],

  // Teammate gap summaries - deterministic values
  teammateGapSummaries: [
    {
      season: 2025,
      team_id: 'RBR',
      driver_primary_id: 'max_verstappen',
      driver_secondary_id: 'sergio_perez',
      driver_pair_gap_percent: 0.77,
      driver_pair_gap_seconds: 0.70,
      gap_percent: 0.77,
      shared_races: 10,
      faster_driver_primary_count: 7,
      coverage_status: 'valid',
      failure_reason: null
    },
    {
      season: 2025,
      team_id: 'MCL',
      driver_primary_id: 'lando_norris',
      driver_secondary_id: 'oscar_piastri',
      driver_pair_gap_percent: 0.33,
      driver_pair_gap_seconds: 0.30,
      gap_percent: 0.33,
      shared_races: 10,
      faster_driver_primary_count: 6,
      coverage_status: 'valid',
      failure_reason: null
    },
    {
      season: 2025,
      team_id: 'FER',
      driver_primary_id: 'charles_leclerc',
      driver_secondary_id: 'carlos_sainz',
      driver_pair_gap_percent: 0.22,
      driver_pair_gap_seconds: 0.20,
      gap_percent: 0.22,
      shared_races: 10,
      faster_driver_primary_count: 5,
      coverage_status: 'valid',
      failure_reason: null
    }
  ] as TeammateGapSummaryFixture[],

  // Generate laps for shared lap analysis
  lapsNormalized: generateLapsNormalized(),

  // Precomputed matchup matrix (based on race data above)
  // VER vs PER: 7-3, NOR vs PIA: 6-4, LEC vs SAI: 5-5 (in both qualifying and race)
  matchupMatrix: [
    // Qualifying
    { driver_a_id: 'max_verstappen', driver_b_id: 'sergio_perez', metric: 'qualifying_position', season: 2025, driver_a_wins: 7, driver_b_wins: 3, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'lando_norris', driver_b_id: 'oscar_piastri', metric: 'qualifying_position', season: 2025, driver_a_wins: 6, driver_b_wins: 4, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'carlos_sainz', driver_b_id: 'charles_leclerc', metric: 'qualifying_position', season: 2025, driver_a_wins: 5, driver_b_wins: 5, ties: 0, shared_events: 10, coverage_status: 'valid' },
    // Race
    { driver_a_id: 'max_verstappen', driver_b_id: 'sergio_perez', metric: 'race_finish_position', season: 2025, driver_a_wins: 7, driver_b_wins: 3, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'lando_norris', driver_b_id: 'oscar_piastri', metric: 'race_finish_position', season: 2025, driver_a_wins: 6, driver_b_wins: 4, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'carlos_sainz', driver_b_id: 'charles_leclerc', metric: 'race_finish_position', season: 2025, driver_a_wins: 5, driver_b_wins: 5, ties: 0, shared_events: 10, coverage_status: 'valid' },
    // Cross-team comparisons with sufficient data
    { driver_a_id: 'charles_leclerc', driver_b_id: 'max_verstappen', metric: 'qualifying_position', season: 2025, driver_a_wins: 2, driver_b_wins: 8, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'charles_leclerc', driver_b_id: 'max_verstappen', metric: 'race_finish_position', season: 2025, driver_a_wins: 2, driver_b_wins: 8, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'lando_norris', driver_b_id: 'max_verstappen', metric: 'qualifying_position', season: 2025, driver_a_wins: 3, driver_b_wins: 7, ties: 0, shared_events: 10, coverage_status: 'valid' },
    { driver_a_id: 'lando_norris', driver_b_id: 'max_verstappen', metric: 'race_finish_position', season: 2025, driver_a_wins: 3, driver_b_wins: 7, ties: 0, shared_events: 10, coverage_status: 'valid' }
  ] as MatchupMatrixFixture[]
};

/**
 * Generate deterministic lap data for multiple tracks and drivers
 */
function generateLapsNormalized(): LapNormalizedFixture[] {
  const laps: LapNormalizedFixture[] = [];
  const drivers = ['max_verstappen', 'sergio_perez', 'charles_leclerc', 'carlos_sainz', 'lando_norris', 'oscar_piastri'];
  const tracks = ['bahrain', 'jeddah', 'silverstone'];

  // Generate 50 laps per driver per track for 2025
  for (let round = 1; round <= 3; round++) {
    const track = tracks[round - 1];
    for (const driver of drivers) {
      // Base lap time varies by driver
      const driverOffset = drivers.indexOf(driver) * 0.1;
      const baseLapTime = 90.0 + driverOffset;

      for (let lap = 1; lap <= 50; lap++) {
        // Small variation per lap
        const lapVariation = (lap % 5) * 0.02;
        laps.push({
          season: 2025,
          round,
          track_id: track,
          driver_id: driver,
          lap_number: lap,
          lap_time_seconds: baseLapTime + lapVariation,
          is_valid_lap: lap % 10 !== 0, // Every 10th lap is invalid (pit, etc.)
          is_pit_lap: lap % 15 === 0,
          clean_air_flag: lap % 3 !== 0, // 2/3 of laps are clean air
          is_out_lap: lap === 1,
          is_in_lap: lap === 50
        });
      }
    }
  }

  return laps;
}

/**
 * Expected test results for deterministic verification
 */
export const EXPECTED_RESULTS = {
  // Head-to-head counts (from fixtures)
  h2h: {
    ver_vs_per_quali: { driver_a_wins: 7, driver_b_wins: 3, shared_events: 10 },
    nor_vs_pia_quali: { driver_a_wins: 6, driver_b_wins: 4, shared_events: 10 },
    lec_vs_sai_quali: { driver_a_wins: 5, driver_b_wins: 5, shared_events: 10 }
  },
  // Teammate gap percentages
  teammateGaps: {
    rbr: 0.77,
    mcl: 0.33,
    fer: 0.22
  },
  // Multi-comparison rankings (by avg_true_pace, lower is better)
  multiComparisonOrder: ['max_verstappen', 'lando_norris', 'charles_leclerc', 'oscar_piastri', 'carlos_sainz', 'sergio_perez']
};
