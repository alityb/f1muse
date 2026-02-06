# Production Invariants

This document describes the invariant enforcement system that prevents silent data corruption.

## Configuration

### Environment Variable

```
STRICT_INVARIANTS=true
```

### Behavior

| Environment | STRICT_INVARIANTS | Action on Violation |
|-------------|-------------------|---------------------|
| Development | (ignored) | **Throw Error** |
| Production | `true` | **Throw Error** |
| Production | `false` or unset | **Log Error Loudly** |

**Principle**: Errors are GOOD. Silent failures are NOT.

## Enforced Invariants

### 1. NORMALIZATION_MISMATCH

**Location**: `ResultFormatter.formatSeasonDriverVsDriver`

**Rule**: When database returns normalized output (has `shared_races` field), the `intent.normalization` MUST equal `'session_median_percent'`.

**Why**: Prevents showing raw lap times with percent units, or normalized data with seconds units.

### 2. UNKNOWN_NORMALIZATION

**Location**: Frontend `getUnitsForNormalization()`

**Rule**: Only recognized normalization types are allowed:
- `session_median_percent` → `%`
- `team_baseline` → `%`
- `none` → `s`
- `raw` → `s`

**Why**: Unknown normalization types would display without proper units.

### 3. INVALID_COVERAGE

**Location**: `ResultFormatter.formatSeasonDriverVsDriver`

**Rule**: Comparison queries MUST have a valid `coverage_status`:
- `valid`
- `low_coverage`
- `insufficient`

**Why**: Missing coverage would hide data quality issues from users.

## Affected Query Types

These invariants apply to comparison queries:
- `season_driver_vs_driver`
- `teammate_gap_summary_season`
- `teammate_gap_dual_comparison`
- `cross_team_track_scoped_driver_comparison`

## Adding New Invariants

1. Add the assertion function in `src/execution/invariants.ts`
2. Call it from the relevant location (formatter, router, etc.)
3. Document it in this file
4. Test both throw and log behavior

## Testing Invariants

To force an invariant violation (for testing):

```typescript
// In test file
import { handleInvariantViolation } from './execution/invariants';

// This will throw in dev, log in prod
handleInvariantViolation(
  'NORMALIZATION_MISMATCH',
  'Test violation',
  { location: 'test', expected: 'foo', actual: 'bar' }
);
```

## Monitoring

In production with `STRICT_INVARIANTS=false`, violations are logged with this format:

```
========================================
[INVARIANT VIOLATION: TYPE] Message
Context: {"location": "...", "expected": "...", "actual": "..."}
========================================
Set STRICT_INVARIANTS=true to throw on this error
```

Search logs for `INVARIANT VIOLATION` to find issues.
