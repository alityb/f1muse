import { Pool } from 'pg';

export interface TeammateCheckResult {
  ok: boolean;
  constructor_id?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TeammatePairResolution {
  ok: boolean;
  driver_ids?: [string, string];
  reason?: string;
  details?: Record<string, unknown>;
}

export async function checkTeammates(
  pool: Pool,
  driverAId: string,
  driverBId: string,
  season: number
): Promise<TeammateCheckResult> {
  const entries = await pool.query(
    `
    SELECT sed.driver_id, sed.constructor_id, sed.entrant_id
    FROM season_entrant_driver sed
    WHERE sed.year = $1
      AND sed.driver_id IN ($2, $3)
      AND sed.test_driver = false
    `,
    [season, driverAId, driverBId]
  );

  const constructorMap = new Map<string, Set<string>>();
  const driverMap = new Map<string, Set<string>>();

  const normalizeTeamId = (value: unknown): string => {
    if (typeof value !== 'string') {
      return '';
    }
    const normalized = value.trim().toLowerCase().replace(/_/g, '-');
    return normalized.endsWith('-f1-team')
      ? normalized.slice(0, -'-f1-team'.length)
      : normalized;
  };

  for (const row of entries.rows) {
    const entrantId = normalizeTeamId(row.entrant_id);
    const constructorId = normalizeTeamId(row.constructor_id);
    const teamId = entrantId || constructorId;
    if (!teamId) {
      continue;
    }

    if (!constructorMap.has(teamId)) {
      constructorMap.set(teamId, new Set());
    }
    constructorMap.get(teamId)!.add(row.driver_id);

    if (!driverMap.has(row.driver_id)) {
      driverMap.set(row.driver_id, new Set());
    }
    driverMap.get(row.driver_id)!.add(teamId);
  }

  const driverAConstructors = driverMap.get(driverAId) || new Set<string>();
  const driverBConstructors = driverMap.get(driverBId) || new Set<string>();

  if (driverAConstructors.size === 0 || driverBConstructors.size === 0) {
    return {
      ok: false,
      reason: 'driver_not_in_season',
      details: { driverAId, driverBId, season }
    };
  }

  if (driverAConstructors.size === 0 || driverBConstructors.size === 0) {
    return {
      ok: false,
      reason: 'driver_missing_entrant',
      details: { driverAId, driverBId, season }
    };
  }

  if (driverAConstructors.size > 1 || driverBConstructors.size > 1) {
    return {
      ok: false,
      reason: 'multiple_constructors',
      details: {
        driverAConstructors: Array.from(driverAConstructors),
        driverBConstructors: Array.from(driverBConstructors)
      }
    };
  }

  const sharedConstructors = Array.from(constructorMap.entries())
    .filter(([, drivers]) => drivers.has(driverAId) && drivers.has(driverBId))
    .map(([constructorId]) => constructorId);

  if (sharedConstructors.length === 0) {
    return {
      ok: false,
      reason: 'not_teammates',
      details: { driverAId, driverBId, season }
    };
  }

  if (sharedConstructors.length > 1) {
    return {
      ok: false,
      reason: 'multiple_constructors',
      details: { sharedConstructors }
    };
  }

  return {
    ok: true,
    constructor_id: sharedConstructors[0]
  };
}

export async function resolveTeammatePairFromConstructor(
  pool: Pool,
  season: number,
  constructorId: string
): Promise<TeammatePairResolution> {
  const normalizedId = constructorId.trim().toLowerCase();
  const driversResult = await pool.query(
    `
    SELECT DISTINCT sed.driver_id
    FROM season_entrant_driver sed
    WHERE sed.year = $1
      AND (
        LOWER(sed.constructor_id) = $2
        OR LOWER(sed.entrant_id) = $2
      )
      AND sed.test_driver = false
    ORDER BY sed.driver_id ASC
    `,
    [season, normalizedId]
  );

  if (driversResult.rows.length === 0) {
    return {
      ok: false,
      reason: 'no_drivers_for_team',
      details: { season, constructorId }
    };
  }

  if (driversResult.rows.length === 1) {
    return {
      ok: false,
      reason: 'only_one_driver',
      details: { season, constructorId }
    };
  }

  if (driversResult.rows.length > 2) {
    return {
      ok: false,
      reason: 'multiple_drivers',
      details: { season, constructorId, drivers: driversResult.rows.map(row => row.driver_id) }
    };
  }

  return {
    ok: true,
    driver_ids: [driversResult.rows[0].driver_id, driversResult.rows[1].driver_id]
  };
}
