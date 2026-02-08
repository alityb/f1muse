import { Pool } from 'pg';
import { DriverRef } from '../types/semantic';
import { humanizeId } from './driver-resolver';

/**
 * Service for resolving driver IDs to full DriverRef objects.
 *
 * Caches results to avoid repeated database lookups.
 * Falls back to humanizing the ID if the driver isn't found in the database.
 */
export class DriverRefService {
  private cache: Map<string, DriverRef> = new Map();

  constructor(private pool: Pool) {}

  /**
   * Resolve a single driver ID to a DriverRef.
   */
  async getRef(driverId: string): Promise<DriverRef> {
    // Check cache first
    const cached = this.cache.get(driverId);
    if (cached) {
      return cached;
    }

    // Query database
    try {
      const result = await this.pool.query(
        `SELECT id, CONCAT(first_name, ' ', last_name) AS display_name, abbreviation FROM driver WHERE id = $1`,
        [driverId]
      );

      let ref: DriverRef;
      if (result.rows.length > 0) {
        const row = result.rows[0];
        ref = {
          id: row.id,
          name: row.display_name,
          short_name: row.abbreviation || undefined,
        };
      } else {
        // Fallback: humanize the ID
        ref = {
          id: driverId,
          name: humanizeId(driverId),
        };
      }

      this.cache.set(driverId, ref);
      return ref;
    } catch (err) {
      // On error, still provide a fallback
      const ref: DriverRef = {
        id: driverId,
        name: humanizeId(driverId),
      };
      this.cache.set(driverId, ref);
      return ref;
    }
  }

  /**
   * Batch resolve multiple driver IDs to DriverRefs.
   * More efficient than calling getRef() repeatedly.
   */
  async getRefs(driverIds: string[]): Promise<Map<string, DriverRef>> {
    const result = new Map<string, DriverRef>();
    const uncachedIds: string[] = [];

    // First, check cache for all IDs
    for (const id of driverIds) {
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
      const queryResult = await this.pool.query(
        `SELECT id, CONCAT(first_name, ' ', last_name) AS display_name, abbreviation FROM driver WHERE id = ANY($1)`,
        [uncachedIds]
      );

      // Build refs from query results
      const foundIds = new Set<string>();
      for (const row of queryResult.rows) {
        const ref: DriverRef = {
          id: row.id,
          name: row.display_name,
          short_name: row.abbreviation || undefined,
        };
        this.cache.set(row.id, ref);
        result.set(row.id, ref);
        foundIds.add(row.id);
      }

      // Fallback for IDs not found in database
      for (const id of uncachedIds) {
        if (!foundIds.has(id)) {
          const ref: DriverRef = {
            id,
            name: humanizeId(id),
          };
          this.cache.set(id, ref);
          result.set(id, ref);
        }
      }
    } catch (err) {
      // On error, fallback all uncached IDs
      for (const id of uncachedIds) {
        const ref: DriverRef = {
          id,
          name: humanizeId(id),
        };
        this.cache.set(id, ref);
        result.set(id, ref);
      }
    }

    return result;
  }

  /**
   * Resolve an ordered pair of driver IDs, preserving order.
   */
  async getOrderedPair(
    driverAId: string,
    driverBId: string,
    orderSource: 'user_query' | 'alphabetic' = 'user_query'
  ): Promise<{
    drivers: [DriverRef, DriverRef];
    order_source: 'user_query' | 'alphabetic';
  }> {
    const refs = await this.getRefs([driverAId, driverBId]);
    const driverA = refs.get(driverAId)!;
    const driverB = refs.get(driverBId)!;

    return {
      drivers: [driverA, driverB],
      order_source: orderSource,
    };
  }

  /**
   * Clear the cache (useful for testing or when driver data changes).
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
