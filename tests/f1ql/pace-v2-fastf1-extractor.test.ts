import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('pace v2 FastF1 extractor', () => {
  it('treats pandas NaT pit timestamps as absent', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/etl/season-ingestion.ts'), 'utf8');

    expect(source).toContain('import pandas as pd');
    expect(source).toContain('return value is not None and not pd.isna(value)');
    expect(source).toContain("'pit_in': is_present_timestamp(row.get('PitInTime'))");
    expect(source).toContain("'pit_out': is_present_timestamp(row.get('PitOutTime'))");
    expect(source).not.toContain("'pit_in': row.get('PitInTime') is not None");
    expect(source).not.toContain("'pit_out': row.get('PitOutTime') is not None");
  });
});
