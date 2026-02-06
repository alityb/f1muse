# Data Ingestion Freeze - 2024 & 2025 Seasons

**Date**: 2025-02-05
**Status**: FROZEN

## Verification Summary

The data completeness audit has verified that all race data for 2024 and 2025 seasons is complete and production-ready.

### Audit Results

| Season | Races | Status | Session Medians | Driver Coverage |
|--------|-------|--------|-----------------|-----------------|
| 2024   | 24    | 100% COMPLETE | All ≥20 valid laps | All classified drivers have ≥5 valid laps |
| 2025   | 24    | 100% COMPLETE | All ≥20 valid laps | All classified drivers have ≥5 valid laps |

### Data Quality Guarantees

For every race in 2024 and 2025:

1. **Session median exists**: ≥20 valid laps available for P50 calculation
2. **Normalized pace data exists**: All classified drivers have ≥5 valid laps
3. **Coverage status**: Queries return `valid` status (≥8 shared races)

### Query Validation

Tested query: `season_driver_vs_driver` (Verstappen vs Norris)

| Season | Shared Races | Coverage Status | Result |
|--------|--------------|-----------------|--------|
| 2024   | 23           | valid           | Difference: -0.002% |
| 2025   | 23           | valid           | Difference: +0.25% |

## Freeze Policy

### DO NOT MODIFY without explicit approval:
- `laps_normalized` table structure or data
- `race` / `race_data` table structure
- Lap validity filtering logic (`is_valid_lap`, `lap_time_seconds IS NOT NULL`)
- Normalization calculation methodology
- Session median threshold (≥20 laps)
- Per-driver lap threshold (≥5 laps)
- Coverage status thresholds (≥8 races = valid)

### Adding New Season Data

When a new season (2026+) needs to be added:

1. Run the audit script first: `npx ts-node scripts/audit-data-completeness.ts`
2. Verify 100% COMPLETE status before deploying
3. Update this document with new audit results
4. Do NOT modify existing 2024/2025 data

## Audit Command

```bash
npx ts-node scripts/audit-data-completeness.ts
```

Expected output should show:
- `✅ ALL RACES COMPLETE - Data is production-ready`
