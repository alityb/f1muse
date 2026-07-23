import { describe, expect, it } from 'vitest';
import { collectF1QLPerformanceEvidence, requireF1QLPerformanceEvidenceConfiguration } from '../../scripts/collect-f1ql-performance-evidence';

describe('F1QL performance evidence', () => {
  it('requires explicit confirmation and refuses loopback targets', () => {
    expect(() => requireF1QLPerformanceEvidenceConfiguration({ DATABASE_URL: 'postgres://db.example/f1' })).toThrow('F1QL_PERFORMANCE_EVIDENCE_ENABLED');
    expect(() => requireF1QLPerformanceEvidenceConfiguration({ F1QL_PERFORMANCE_EVIDENCE_ENABLED: 'true', F1QL_PERFORMANCE_EVIDENCE_TARGET: 'production', DATABASE_URL: 'postgres://localhost/f1' })).toThrow('refuses local');
    expect(requireF1QLPerformanceEvidenceConfiguration({ F1QL_PERFORMANCE_EVIDENCE_ENABLED: 'true', F1QL_PERFORMANCE_EVIDENCE_TARGET: 'production', DATABASE_URL: 'postgres://db.example/f1' })).toBe('postgres://db.example/f1');
  });

  it('uses one rollback-only timeout-bound transaction and emits no SQL or parameter values', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push({ sql, params });
            if (sql.includes('to_regclass')) return { rows: [{ relation: params?.[0] }] };
            if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Aggregate', 'Total Cost': 12.5, 'Plan Rows': 1, Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'laps_normalized_v2' }] } }] }] };
            return { rows: [{ row_count: 1 }] };
          },
          release() {}
        };
      },
      async end() {}
    };

    const evidence = await collectF1QLPerformanceEvidence(pool);

    expect(evidence.status).toBe('observed');
    expect(evidence.sources.map(source => source.source)).toEqual(['standings', 'event_classification', 'qualifying_classification', 'event_metadata', 'lap_pace']);
    expect(evidence.sources.every(source => source.measurements.executions === 7 && source.plan.node_types.includes('Aggregate'))).toBe(true);
    expect(evidence.lap_pace_correction_layers).toHaveLength(4);
    expect(JSON.stringify(evidence)).not.toContain('max-verstappen');
    expect(JSON.stringify(evidence)).not.toContain('SELECT');
    expect(calls[0]).toEqual({ sql: 'BEGIN READ ONLY', params: undefined });
    expect(calls[1]).toEqual({ sql: "SELECT set_config('statement_timeout', $1, true)", params: ['5000ms'] });
    expect(calls.at(-1)).toEqual({ sql: 'ROLLBACK', params: undefined });
    expect(calls.every(call => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(call.sql))).toBe(true);
  });

  it('marks an unavailable correction layer without querying it', async () => {
    const calls: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string, params?: unknown[]) {
            calls.push(sql);
            if (sql.includes('to_regclass')) return { rows: [{ relation: params?.[0] === 'pace_v2_lap_rebuild' ? null : params?.[0] }] };
            if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result', 'Total Cost': 1, 'Plan Rows': 1 } }] }] };
            return { rows: [{}] };
          },
          release() {}
        };
      },
      async end() {}
    };

    const evidence = await collectF1QLPerformanceEvidence(pool);
    expect(evidence.status).toBe('attention');
    expect(evidence.lap_pace_correction_layers).toContainEqual({ layer: 'fastf1_complete_race_v1', relation: 'pace_v2_lap_rebuild', status: 'missing_relation' });
    expect(calls.filter(sql => sql.includes('FROM pace_v2_lap_rebuild'))).toHaveLength(0);
  });
});
