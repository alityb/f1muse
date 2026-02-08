import { Pool } from 'pg';
import { TrackRef } from '../types/semantic';

/**
 * Humanize a track/grand prix ID to a readable name.
 * e.g., 'british_grand_prix' -> 'British Grand Prix'
 */
function humanizeTrackId(trackId: string): string {
  return trackId
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Service for resolving track/grand prix IDs to full TrackRef objects.
 *
 * Caches results to avoid repeated database lookups.
 * Falls back to humanizing the ID if the track isn't found in the database.
 */
export class TrackRefService {
  private cache: Map<string, TrackRef> = new Map();

  constructor(private pool: Pool) {}

  /**
   * Resolve a single track ID to a TrackRef.
   *
   * Handles both grand_prix IDs (e.g., 'british_grand_prix') and
   * circuit IDs (e.g., 'silverstone').
   */
  async getRef(trackId: string): Promise<TrackRef> {
    // Check cache first
    const cached = this.cache.get(trackId);
    if (cached) {
      return cached;
    }

    // Query database
    try {
      // Try grand_prix table first (most common case)
      let result = await this.pool.query(
        `SELECT gp.id, gp.name AS track_name, c.full_name AS circuit_name
         FROM grand_prix gp
         LEFT JOIN circuit c ON c.id = REPLACE(gp.id, '_grand_prix', '')
         WHERE gp.id = $1`,
        [trackId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const ref: TrackRef = {
          id: row.id,
          name: row.track_name,
          circuit_name: row.circuit_name || undefined,
        };
        this.cache.set(trackId, ref);
        return ref;
      }

      // Try circuit table as fallback
      result = await this.pool.query(
        `SELECT id, name, full_name AS circuit_name FROM circuit WHERE id = $1`,
        [trackId]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const ref: TrackRef = {
          id: row.id,
          name: row.name,
          circuit_name: row.circuit_name || undefined,
        };
        this.cache.set(trackId, ref);
        return ref;
      }

      // Fallback: humanize the ID
      const ref: TrackRef = {
        id: trackId,
        name: humanizeTrackId(trackId),
      };
      this.cache.set(trackId, ref);
      return ref;
    } catch (err) {
      // On error, still provide a fallback
      const ref: TrackRef = {
        id: trackId,
        name: humanizeTrackId(trackId),
      };
      this.cache.set(trackId, ref);
      return ref;
    }
  }

  /**
   * Batch resolve multiple track IDs to TrackRefs.
   * More efficient than calling getRef() repeatedly.
   */
  async getRefs(trackIds: string[]): Promise<Map<string, TrackRef>> {
    const result = new Map<string, TrackRef>();
    const uncachedIds: string[] = [];

    // First, check cache for all IDs
    for (const id of trackIds) {
      const cached = this.cache.get(id);
      if (cached) {
        result.set(id, cached);
      } else {
        uncachedIds.push(id);
      }
    }

    // If all were cached, return early
    if (uncachedIds.length === 0) {
      return result;
    }

    // Batch query uncached IDs
    try {
      // Query grand_prix table first
      const gpResult = await this.pool.query(
        `SELECT gp.id, gp.name AS track_name, c.full_name AS circuit_name
         FROM grand_prix gp
         LEFT JOIN circuit c ON c.id = REPLACE(gp.id, '_grand_prix', '')
         WHERE gp.id = ANY($1)`,
        [uncachedIds]
      );

      const foundIds = new Set<string>();
      for (const row of gpResult.rows) {
        const ref: TrackRef = {
          id: row.id,
          name: row.track_name,
          circuit_name: row.circuit_name || undefined,
        };
        this.cache.set(row.id, ref);
        result.set(row.id, ref);
        foundIds.add(row.id);
      }

      // Query circuit table for remaining IDs
      const remainingIds = uncachedIds.filter((id) => !foundIds.has(id));
      if (remainingIds.length > 0) {
        const circuitResult = await this.pool.query(
          `SELECT id, name, full_name AS circuit_name FROM circuit WHERE id = ANY($1)`,
          [remainingIds]
        );

        for (const row of circuitResult.rows) {
          const ref: TrackRef = {
            id: row.id,
            name: row.name,
            circuit_name: row.circuit_name || undefined,
          };
          this.cache.set(row.id, ref);
          result.set(row.id, ref);
          foundIds.add(row.id);
        }
      }

      // Fallback for IDs not found in either table
      for (const id of uncachedIds) {
        if (!foundIds.has(id)) {
          const ref: TrackRef = {
            id,
            name: humanizeTrackId(id),
          };
          this.cache.set(id, ref);
          result.set(id, ref);
        }
      }
    } catch (err) {
      // On error, fallback all uncached IDs
      for (const id of uncachedIds) {
        const ref: TrackRef = {
          id,
          name: humanizeTrackId(id),
        };
        this.cache.set(id, ref);
        result.set(id, ref);
      }
    }

    return result;
  }

  /**
   * Clear the cache (useful for testing or when track data changes).
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for monitoring).
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
